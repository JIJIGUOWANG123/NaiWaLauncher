import { useCallback, useEffect, useMemo, useState } from "react";
import type { InstalledModInfo, InstanceMeta, LoaderKind, WindowMode } from "../../shared/types";
import { api } from "../lib/api";
import { LITELOADER_VERSION_HINT, formatBytes, loaderLabel, liteloaderUnsupported } from "../lib/format";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "./Toast";
import { Drawer } from "./Drawer";
import { ConfirmDialog } from "./Modal";
import { Segmented, Select, TextInput, type SelectOption } from "./Form";
import { IconCheck } from "./icons";
import { LoaderBadge } from "./Badges";
import { EmptyState, ErrorState, SkeletonRows } from "./State";
import { IconRefresh, IconTrash, IconZap } from "./icons";

const LOADER_OPTIONS: Array<{ value: LoaderKind; label: string }> = [
  { value: "vanilla", label: "原版（不装加载器）" },
  { value: "fabric", label: "Fabric" },
  { value: "quilt", label: "Quilt" },
  { value: "forge", label: "Forge" },
  { value: "neoforge", label: "NeoForge" },
  { value: "liteloader", label: "LiteLoader" },
];

const WINDOW_MODE_OPTIONS: Array<{ value: WindowMode; label: string }> = [
  { value: "inherit", label: "跟随全局" },
  { value: "windowed", label: "窗口" },
  { value: "fullscreen", label: "全屏" },
];

const WINDOW_SIZE_PRESETS = ["inherit", "default", "1024x768", "1280x720", "1600x900", "1920x1080"];

const WINDOW_SIZE_OPTIONS: SelectOption[] = [
  { value: "inherit", label: "跟随全局" },
  { value: "default", label: "原版默认（854 × 480）" },
  { value: "1024x768", label: "1024 × 768" },
  { value: "1280x720", label: "1280 × 720" },
  { value: "1600x900", label: "1600 × 900" },
  { value: "1920x1080", label: "1920 × 1080" },
  { value: "custom", label: "自定义…" },
];

/** "1920x1080" → {w,h}；inherit / default / 非法值返回 null。 */
function parseWindowSize(value: string): { w: number; h: number } | null {
  const matched = /^(\d{3,5})x(\d{3,5})$/i.exec(value.trim());
  return matched ? { w: Number(matched[1]), h: Number(matched[2]) } : null;
}

/** 实例详情：加载器切换 + 模组统一管理，做成宽抽屉而不是新路由。 */
export function InstanceDetailDrawer({
  instance, open, onClose, onChanged,
}: {
  instance: InstanceMeta | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { push } = useToast();
  // 模组列表按「其它 → Mod 管理样式」决定首行显示译名还是文件名。
  const { settings } = useApp();
  const display = settings?.modDisplayStyle ?? "title";
  const instanceId = instance?.id ?? null;

  const [mods, setMods] = useState<InstalledModInfo[] | null>(null);
  const [modsLoading, setModsLoading] = useState(false);
  const [modsError, setModsError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [removing, setRemoving] = useState<InstalledModInfo | null>(null);
  const [busyRemove, setBusyRemove] = useState(false);

  const [targetLoader, setTargetLoader] = useState<LoaderKind>("vanilla");
  const [targetVersion, setTargetVersion] = useState("");
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [switching, setSwitching] = useState(false);

  const [javaDraft, setJavaDraft] = useState("");
  const [savingJava, setSavingJava] = useState(false);
  const [javaExists, setJavaExists] = useState<boolean | null>(null);
  const [javaTick, setJavaTick] = useState(0);

  const [windowMode, setWindowMode] = useState<WindowMode>("inherit");
  const [windowSize, setWindowSize] = useState("inherit");
  const [sizeCustom, setSizeCustom] = useState(false);
  const [sizeW, setSizeW] = useState("1280");
  const [sizeH, setSizeH] = useState("720");
  const [savingWindow, setSavingWindow] = useState(false);

  const loadMods = useCallback(async () => {
    if (!instanceId) return;
    setModsLoading(true);
    try {
      setMods(await api.mods.installed(instanceId));
      setModsError(null);
    } catch (error: unknown) {
      setModsError(errorMessage(error));
    } finally {
      setModsLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    if (!open || !instanceId) return;
    setMods(null);
    setModsError(null);
    void loadMods();
  }, [open, instanceId, loadMods]);

  // 实例被刷新（例如切换加载器成功）后，草稿选择跟着回到当前状态。
  useEffect(() => {
    if (!instance) return;
    setTargetLoader(instance.loader);
    setTargetVersion(instance.loaderVersion ?? "");
  }, [instance?.id, instance?.loader, instance?.loaderVersion]);

  // 实例的 MC 版本高于 1.12.2 时不支持 LiteLoader：直接不发请求并禁用版本下拉。
  const liteloaderBlocked = targetLoader === "liteloader"
    && liteloaderUnsupported(instance?.mcVersion ?? "");

  const loaderVersions = useAsync(
    () => (open && instance && targetLoader !== "vanilla" && !liteloaderBlocked
      ? api.versions.loaders(instance.mcVersion, targetLoader)
      : Promise.resolve([])),
    [open, instance?.mcVersion, targetLoader],
  );

  useEffect(() => {
    if (targetLoader === "vanilla" || liteloaderBlocked) {
      setTargetVersion("");
      return;
    }
    const list = loaderVersions.data ?? [];
    if (targetLoader === instance?.loader && instance?.loaderVersion) {
      setTargetVersion(instance.loaderVersion);
      return;
    }
    if (list.length === 0) return;
    setTargetVersion((prev) => (list.some((item) => item.version === prev)
      ? prev
      : (list.find((item) => item.stable) ?? list[0]).version));
  }, [targetLoader, loaderVersions.data, instance?.loader, instance?.loaderVersion, liteloaderBlocked]);

  const installedJava = useAsync(
    () => (open ? api.java.installed() : Promise.resolve([])),
    [open],
  );

  const savedJavaPath = (instance?.javaPath ?? "").trim();

  // 切实例或保存成功后，下拉草稿回到实例当前值。
  useEffect(() => {
    setJavaDraft(savedJavaPath);
  }, [instance?.id, savedJavaPath]);

  // 启动窗口：草稿跟随实例当前值（保存成功由 onChanged 回填，失败由回滚函数复位）。
  useEffect(() => {
    if (!instance) return;
    setWindowMode(instance.windowMode ?? "inherit");
    const size = (instance.windowSize ?? "").trim() || "inherit";
    setWindowSize(size);
    setSizeCustom(!WINDOW_SIZE_PRESETS.includes(size));
    const parsed = parseWindowSize(size);
    if (parsed) {
      setSizeW(String(parsed.w));
      setSizeH(String(parsed.h));
    }
  }, [instance?.id, instance?.windowMode, instance?.windowSize]);

  // 用主进程 fs.access 判断已保存的路径是否还在（外部 JDK 也能判断）。
  useEffect(() => {
    let alive = true;
    setJavaExists(null);
    if (!open || !savedJavaPath) return () => { alive = false; };
    void api.app.pathExists(savedJavaPath)
      .then((ok) => { if (alive) setJavaExists(ok); })
      .catch(() => { if (alive) setJavaExists(null); });
    return () => { alive = false; };
  }, [open, savedJavaPath, javaTick]);

  const javaOptions = useMemo<SelectOption[]>(
    () => (installedJava.data ?? []).map((item) => ({
      value: item.path,
      label: `Java ${item.major} · ${item.vendor}`,
      title: item.path,
    })),
    [installedJava.data],
  );

  const updatableCount = useMemo(
    () => (mods ?? []).filter((item) => item.update).length,
    [mods],
  );

  const unchanged = instance !== null
    && targetLoader === instance.loader
    && (targetLoader === "vanilla" || targetVersion === (instance.loaderVersion ?? ""))
    && (targetLoader !== "vanilla" || instance.loader === "vanilla");

  const checkUpdates = async () => {
    if (!instanceId) return;
    setChecking(true);
    try {
      const next = await api.mods.checkUpdates(instanceId);
      setMods(next);
      const found = next.filter((item) => item.update).length;
      push(found > 0 ? `检查完成：共 ${next.length} 个模组，${found} 个可更新` : `检查完成：共 ${next.length} 个模组，暂无更新`, "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setChecking(false);
    }
  };

  const applyUpdate = async (mod: InstalledModInfo) => {
    if (!instanceId || !mod.update) return;
    setUpdating(mod.fileName);
    try {
      const result = await api.mods.update(instanceId, mod.fileName);
      push(`已更新为 ${result.fileName}`, "success");
      await loadMods();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setUpdating(null);
    }
  };

  const confirmRemove = async () => {
    if (!instanceId || !removing) return;
    setBusyRemove(true);
    try {
      await api.mods.remove(instanceId, removing.fileName);
      push(`已删除 ${removing.name ?? removing.fileName}`, "success");
      setRemoving(null);
      await loadMods();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusyRemove(false);
    }
  };

  const applyLoader = async () => {
    if (!instance) return;
    setConfirmSwitch(false);
    setSwitching(true);
    try {
      const updated = await api.instances.setLoader(
        instance.id,
        targetLoader,
        targetLoader === "vanilla" ? undefined : targetVersion || undefined,
      );
      push(`加载器已切换为 ${loaderLabel(updated.loader)}${updated.loaderVersion ? ` ${updated.loaderVersion}` : ""}`, "success");
      onChanged();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setSwitching(false);
    }
  };

  const saveJava = async (value: string) => {
    if (!instance) return;
    const path = value.trim();
    setSavingJava(true);
    try {
      await api.instances.update(instance.id, { javaPath: path });
      push(path ? `已指定 Java：${path}` : "已切换为自动匹配 Java 版本", "success");
      setJavaTick((tick) => tick + 1);
      onChanged();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setSavingJava(false);
    }
  };

  // 启动窗口：改动即时保存，失败回滚 UI 并 toast 错误。
  const saveWindow = async (patch: { windowMode?: WindowMode; windowSize?: string }, revert: () => void) => {
    if (!instance) return;
    setSavingWindow(true);
    try {
      await api.instances.update(instance.id, patch);
      push("启动窗口已保存", "success");
      onChanged();
    } catch (error: unknown) {
      revert();
      push(errorMessage(error), "error");
    } finally {
      setSavingWindow(false);
    }
  };

  const changeWindowMode = (next: WindowMode) => {
    if (!instance || next === windowMode) return;
    const previous = windowMode;
    setWindowMode(next);
    void saveWindow({ windowMode: next }, () => setWindowMode(previous));
  };

  const changeWindowSize = (next: string) => {
    if (!instance) return;
    if (next === "custom") {
      setSizeCustom(true);
      return;
    }
    const previousSize = windowSize;
    const previousCustom = sizeCustom;
    setWindowSize(next);
    setSizeCustom(false);
    void saveWindow({ windowSize: next }, () => {
      setWindowSize(previousSize);
      setSizeCustom(previousCustom);
    });
  };

  const applyCustomSize = () => {
    if (!instance) return;
    const w = Math.round(Number(sizeW));
    const h = Math.round(Number(sizeH));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 640 || h < 480 || w > 7680 || h > 4320) {
      push("窗口宽高需在 640×480 – 7680×4320 之间", "error");
      return;
    }
    const value = `${w}x${h}`;
    const previousSize = windowSize;
    const previousCustom = sizeCustom;
    setWindowSize(value);
    setSizeCustom(true);
    void saveWindow({ windowSize: value }, () => {
      setWindowSize(previousSize);
      setSizeCustom(previousCustom);
    });
  };

  const switchTarget = targetLoader === "vanilla"
    ? "原版"
    : `${loaderLabel(targetLoader)} ${targetVersion || "（最新稳定版）"}`;

  return (
    <>
      <Drawer
        open={open && instance !== null}
        title={instance?.name ?? ""}
        subtitle={instance ? `Minecraft ${instance.mcVersion} · 启动版本 ${instance.versionId}` : undefined}
        width={760}
        onClose={onClose}
      >
        {instance ? (
          <div className="detail-hero">
            <div className="detail-hero-badges">
              <span className="field-label">当前加载器</span>
              <LoaderBadge loader={instance.loader} />
              <span className="badge detail-version">{instance.loaderVersion ?? "无需加载器版本"}</span>
            </div>
            <div className="detail-hero-meta">
              <span className="field-label">Minecraft 版本</span>
              <span className="detail-mc">{instance.mcVersion}</span>
            </div>
          </div>
        ) : null}

        <section className="detail-section">
          <div className="drawer-section-head">
            <span className="field-label">加载器</span>
            <span className="muted-text">切换会重装 <code className="mono">.minecraft/versions</code> 下的加载器版本</span>
          </div>

          <div className={`detail-loader-row ${targetLoader === "vanilla" ? "is-vanilla" : ""}`}>
            <div className="field">
              <span className="field-label">目标加载器</span>
              <Select
                value={targetLoader}
                options={LOADER_OPTIONS}
                onChange={(value) => setTargetLoader(value as LoaderKind)}
                ariaLabel="目标加载器"
                disabled={switching}
              />
            </div>
            {targetLoader === "vanilla" ? null : (
              <div className="field">
                <span className="field-label">加载器版本</span>
                <Select
                  value={targetVersion}
                  options={(loaderVersions.data ?? []).map((item) => ({
                    value: item.version,
                    label: item.stable ? item.version : `${item.version}（测试版）`,
                  }))}
                  onChange={setTargetVersion}
                  ariaLabel="加载器版本"
                  placeholder={liteloaderBlocked
                    ? "该 MC 版本不支持 LiteLoader"
                    : (loaderVersions.loading ? "读取中…" : "请选择加载器版本")}
                  disabled={switching || loaderVersions.loading || liteloaderBlocked}
                />
                {liteloaderBlocked ? (
                  <span className="field-hint" data-litloader-warning>{LITELOADER_VERSION_HINT}</span>
                ) : null}
              </div>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setConfirmSwitch(true)}
              disabled={switching || unchanged || liteloaderBlocked || (targetLoader !== "vanilla" && !targetVersion)}
            >
              {switching ? "切换中…" : "切换加载器"}
            </button>
          </div>

          {loaderVersions.error && targetLoader !== "vanilla" ? (
            <ErrorState message={loaderVersions.error} onRetry={loaderVersions.reload} />
          ) : null}

          {switching ? (
            <p className="detail-progress" role="status">
              <span className="spinner" aria-hidden="true" />
              正在安装 {switchTarget}，完成后模组目录保持不变…
            </p>
          ) : (
            <p className="hint-inline">切换后模组目录保留，但加载器专属模组可能不再生效。</p>
          )}
        </section>

        <section className="detail-section">
          <div className="drawer-section-head">
            <span className="field-label">Java</span>
            <span className="muted-text" data-java-mode>
              {savedJavaPath ? "手动指定" : "自动匹配（按游戏版本）"}
            </span>
          </div>

          <div className="detail-java-row">
            <div className="field">
              <span className="field-label">运行环境</span>
              <Select
                value={javaDraft}
                options={javaOptions}
                onChange={setJavaDraft}
                placeholder={installedJava.loading ? "读取已安装 JDK…" : "自动匹配（按游戏版本）"}
                ariaLabel="Java 运行环境"
                disabled={savingJava || installedJava.loading}
              />
              <span className="field-hint detail-java-path" title={javaDraft || "由启动器按游戏版本挑选 JDK"}>
                {javaDraft || "由启动器按游戏版本挑选 JDK"}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void saveJava(javaDraft)}
              disabled={savingJava || installedJava.loading || javaDraft.trim() === savedJavaPath}
            >
              <IconCheck size={15} />
              {savingJava ? "保存中…" : "保存"}
            </button>
          </div>

          {installedJava.error ? <ErrorState message={installedJava.error} onRetry={installedJava.reload} /> : null}

          {javaDraft.trim() === "" ? (
            <p className="hint-inline">
              自动匹配规则：优先按版本 JSON 的 javaVersion；兜底为 ≤1.16.5 → Java 8、1.17–1.20.4 → Java 17、1.20.5–1.25 → Java 21、26.x 起 → Java 25。
            </p>
          ) : null}

          {javaExists === false ? (
            <div className="detail-java-stale" data-java-stale>
              <div className="detail-java-stale-main">
                <span className="badge detail-java-stale-tag">已失效的路径</span>
                <p className="detail-java-stale-path mono" title={savedJavaPath}>{savedJavaPath}</p>
                <p className="field-hint">这个位置已经找不到 javaw.exe（文件被移动或删除），启动会失败。</p>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                data-action="clear-java"
                onClick={() => {
                  setJavaDraft("");
                  void saveJava("");
                }}
                disabled={savingJava}
              >
                清除
              </button>
            </div>
          ) : null}

          {settings?.javaAutoMatch === false && savedJavaPath === "" ? (
            <p className="hint-inline">设置里已关闭「自动匹配 Java 版本」，这个实例必须指定 JDK，否则启动会报错。</p>
          ) : null}
        </section>

        <section className="detail-section" data-detail-window>
          <div className="drawer-section-head">
            <span className="field-label">启动窗口</span>
            <span className="muted-text" data-window-mode-current>
              {windowMode === "inherit" ? "跟随全局设置" : windowMode === "fullscreen" ? "全屏" : "窗口"}
            </span>
          </div>

          <div className="detail-window-row">
            <div className="field">
              <span className="field-label">形态</span>
              <Segmented value={windowMode} options={WINDOW_MODE_OPTIONS} onChange={changeWindowMode} />
            </div>
            <div className="field">
              <span className="field-label">尺寸</span>
              <Select
                value={sizeCustom ? "custom" : windowSize}
                options={WINDOW_SIZE_OPTIONS}
                onChange={changeWindowSize}
                ariaLabel="启动窗口尺寸"
                disabled={savingWindow || windowMode === "fullscreen"}
              />
            </div>
          </div>

          {sizeCustom ? (
            <div className="detail-window-custom" data-window-custom>
              <TextInput
                type="number"
                min={640}
                max={7680}
                value={sizeW}
                aria-label="窗口宽度"
                onChange={(event) => setSizeW(event.target.value)}
                disabled={savingWindow || windowMode === "fullscreen"}
              />
              <span className="window-size-x">×</span>
              <TextInput
                type="number"
                min={480}
                max={4320}
                value={sizeH}
                aria-label="窗口高度"
                onChange={(event) => setSizeH(event.target.value)}
                disabled={savingWindow || windowMode === "fullscreen"}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                data-action="apply-window-size"
                onClick={applyCustomSize}
                disabled={savingWindow || windowMode === "fullscreen"}
              >
                应用
              </button>
            </div>
          ) : null}

          {windowMode === "fullscreen" ? (
            <p className="hint-inline" data-window-fullscreen-hint>全屏使用桌面分辨率</p>
          ) : null}

          <p className="hint-inline">跟随全局表示使用「启动」页里的窗口大小设置；实例设置优先生效。</p>
        </section>

        <section className="detail-section">
          <div className="drawer-section-head">
            <span className="field-label">模组列表</span>
            <span className="muted-text" data-mods-stats>
              {mods ? `共 ${mods.length} 个，可更新 ${updatableCount} 个` : "正在读取 mods 目录…"}
            </span>
          </div>

          <div className="detail-mods-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void checkUpdates()}
              disabled={checking || modsLoading || mods === null}
            >
              <IconZap size={15} />
              {checking ? "检查中…" : "检查更新"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void loadMods()}
              disabled={modsLoading || checking}
            >
              <IconRefresh size={15} />
              刷新
            </button>
          </div>

          {modsLoading && mods === null ? <SkeletonRows count={3} /> : null}
          {modsError ? <ErrorState message={modsError} onRetry={() => void loadMods()} /> : null}

          {!modsError && mods !== null && mods.length === 0 ? (
            <EmptyState
              title="这个实例还没有模组"
              hint="把模组装进这个实例后，这里可以统一管理与更新"
            />
          ) : null}

          {!modsError && mods !== null && mods.length > 0 ? (
            <ul className="detail-mods-table">
              <li className="detail-mods-row is-head" aria-hidden="true">
                <span>{display === "filename" ? "文件名" : "名称"}</span>
                <span>版本</span>
                <span>大小</span>
                <span className="detail-mods-ops">操作</span>
              </li>
              {mods.map((mod) => (
                <li
                  key={mod.fileName}
                  className={`detail-mods-row ${mod.update ? "has-update" : ""}`}
                  data-mod-file={mod.fileName}
                >
                  <div className="detail-mod-main" data-display-style={display}>
                    <span className="detail-mod-name">
                      {display === "filename" ? mod.fileName : (mod.name ?? mod.fileName)}
                    </span>
                    <span className="detail-mod-file" title={display === "filename" ? (mod.name ?? mod.fileName) : mod.fileName}>
                      {display === "filename" ? (mod.name ?? mod.fileName) : mod.fileName}
                    </span>
                    {mod.update ? (
                      <span className="badge detail-update-tag">可更新 → {mod.update.versionLabel}</span>
                    ) : null}
                  </div>
                  <span className="detail-mod-version">{mod.version ?? "—"}</span>
                  <span className="detail-mod-size">{formatBytes(mod.sizeBytes)}</span>
                  <div className="detail-mods-ops">
                    <button
                      type="button"
                      className={`btn btn-sm ${mod.update ? "btn-update-on" : "btn-ghost"}`}
                      data-action="update"
                      onClick={() => void applyUpdate(mod)}
                      disabled={!mod.update || updating !== null || removing !== null}
                      title={mod.update ? `更新到 ${mod.update.versionLabel}` : "没有可用更新"}
                    >
                      {updating === mod.fileName ? "更新中…" : "更新"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-ghost"
                      data-action="delete"
                      onClick={() => setRemoving(mod)}
                      disabled={busyRemove || updating !== null}
                    >
                      <IconTrash size={14} />
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <ConfirmDialog
          open={confirmSwitch}
          title="切换加载器"
          message={instance
            ? `把「${instance.name}」的加载器切换为 ${switchTarget}？切换后模组目录保留，但加载器专属模组可能不再生效。`
            : ""}
          confirmText="切换"
          busy={switching}
          onCancel={() => setConfirmSwitch(false)}
          onConfirm={() => void applyLoader()}
        />

        <ConfirmDialog
          open={removing !== null}
          title="删除模组"
          message={removing ? `确定删除 ${removing.name ?? removing.fileName} 吗？文件会从该实例的 mods 目录移除。` : ""}
          confirmText="删除"
          danger
          busy={busyRemove}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void confirmRemove()}
        />
      </Drawer>
    </>
  );
}