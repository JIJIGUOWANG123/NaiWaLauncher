import { useEffect, useMemo, useState } from "react";
import type { InstanceMeta, LoaderKind, WindowMode } from "../../shared/types";
import { api } from "../lib/api";
import { formatBytes, instanceDiskUsage, loaderLabel, liteloaderUnsupported, liteloaderVersionHint } from "../lib/format";
import { useT } from "../lib/i18n";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "./Toast";
import { Drawer } from "./Drawer";
import { ConfirmDialog } from "./Modal";
import { Segmented, Select, TextInput, type SelectOption } from "./Form";
import { IconCheck } from "./icons";
import { LoaderBadge } from "./Badges";
import { ErrorState } from "./State";
import { IconRefresh } from "./icons";

type Translator = (key: string, vars?: Record<string, string | number>) => string;

/** 加载器下拉：原版走词典，其余是专有名词，保持英文。 */
function loaderOptions(tr: Translator): Array<{ value: LoaderKind; label: string }> {
  return [
    { value: "vanilla", label: tr("pages.instanceDetail.loaderVanilla") },
    { value: "fabric", label: "Fabric" },
    { value: "quilt", label: "Quilt" },
    { value: "forge", label: "Forge" },
    { value: "neoforge", label: "NeoForge" },
    { value: "liteloader", label: "LiteLoader" },
  ];
}

const WINDOW_MODE_OPTIONS: Array<{ value: WindowMode; labelKey: string }> = [
  { value: "inherit", labelKey: "pages.instanceDetail.windowInherit" },
  { value: "windowed", labelKey: "pages.instanceDetail.windowWindowed" },
  { value: "fullscreen", labelKey: "pages.instanceDetail.windowFullscreen" },
];

const WINDOW_SIZE_PRESETS = ["inherit", "default", "1024x768", "1280x720", "1600x900", "1920x1080"];

const WINDOW_SIZE_OPTIONS: Array<Omit<SelectOption, "label"> & { labelKey?: string; label?: string }> = [
  { value: "inherit", labelKey: "pages.instanceDetail.windowInherit" },
  { value: "default", labelKey: "pages.instanceDetail.sizeVanillaDefault" },
  { value: "1024x768", label: "1024 × 768" },
  { value: "1280x720", label: "1280 × 720" },
  { value: "1600x900", label: "1600 × 900" },
  { value: "1920x1080", label: "1920 × 1080" },
  { value: "custom", labelKey: "pages.instanceDetail.windowCustom" },
];

/** 选项文案存 key，渲染时再翻；纯尺寸标签直接给出字面量。 */
function localizeSizes(options: typeof WINDOW_SIZE_OPTIONS, tr: Translator): SelectOption[] {
  return options.map(({ value, labelKey, label }) => ({ value, label: labelKey ? tr(labelKey) : (label ?? value) }));
}

/** "1920x1080" → {w,h}；inherit / default / 非法值返回 null。 */
function parseWindowSize(value: string): { w: number; h: number } | null {
  const matched = /^(\d{3,5})x(\d{3,5})$/i.exec(value.trim());
  return matched ? { w: Number(matched[1]), h: Number(matched[2]) } : null;
}

/** 实例设置抽屉：加载器切换、Java 与启动窗口；模组/光影/资源包的列表独立在 ContentDrawer。 */
export function InstanceDetailDrawer({
  instance, open, onClose, onChanged,
}: {
  instance: InstanceMeta | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { push } = useToast();
  const { settings } = useApp();
  const tr = useT();
  const instanceId = instance?.id ?? null;

  const [targetLoader, setTargetLoader] = useState<LoaderKind>("vanilla");
  const [targetVersion, setTargetVersion] = useState("");
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [switching, setSwitching] = useState(false);

  const [javaDraft, setJavaDraft] = useState("");
  const [savingJava, setSavingJava] = useState(false);
  const [javaExists, setJavaExists] = useState<boolean | null>(null);
  const [javaTick, setJavaTick] = useState(0);

  // 本地占用：重新统计后先用返回值覆盖显示，实例列表刷新（onChanged）再回填卡片。
  const [restatting, setRestatting] = useState(false);
  const [diskOverride, setDiskOverride] = useState<number | null>(null);

  const [windowMode, setWindowMode] = useState<WindowMode>("inherit");
  const [windowSize, setWindowSize] = useState("inherit");
  const [sizeCustom, setSizeCustom] = useState(false);
  const [sizeW, setSizeW] = useState("1280");
  const [sizeH, setSizeH] = useState("720");
  const [savingWindow, setSavingWindow] = useState(false);

  // 换实例时丢掉上一次的统计结果，回到该实例自己的 diskUsageBytes。
  useEffect(() => {
    setDiskOverride(null);
  }, [instanceId]);

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

  const unchanged = instance !== null
    && targetLoader === instance.loader
    && (targetLoader === "vanilla" || targetVersion === (instance.loaderVersion ?? ""))
    && (targetLoader !== "vanilla" || instance.loader === "vanilla");

  // 重新统计本地占用：force=true 跳过主进程缓存，结果写回实例并刷新列表。
  const restatDiskUsage = async () => {
    if (!instanceId) return;
    setRestatting(true);
    try {
      const { bytes } = await api.instances.usage(instanceId, true);
      setDiskOverride(bytes);
      push(tr("pages.instanceDetail.restatted", { size: formatBytes(bytes) }), "success");
      onChanged();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setRestatting(false);
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
      push(
        tr("pages.instanceDetail.loaderSwitched", {
          loader: `${loaderLabel(updated.loader, tr)}${updated.loaderVersion ? ` ${updated.loaderVersion}` : ""}`,
        }),
        "success",
      );
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
      push(path ? tr("pages.instanceDetail.javaPinned", { path }) : tr("pages.instanceDetail.javaAuto"), "success");
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
      push(tr("pages.instanceDetail.windowSaved"), "success");
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
      push(tr("pages.instanceDetail.sizeOutOfRange"), "error");
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

  const diskText = instance
    ? (diskOverride === null ? instanceDiskUsage(instance, tr) : formatBytes(diskOverride))
    : tr("pages.instanceDetail.diskCalculating");

  const switchTarget = targetLoader === "vanilla"
    ? tr("pages.instanceDetail.loaderVanillaShort")
    : `${loaderLabel(targetLoader, tr)} ${targetVersion || tr("pages.instanceDetail.latestStable")}`;

  return (
    <>
      <Drawer
        open={open && instance !== null}
        title={instance?.name ?? ""}
        subtitle={instance ? tr("pages.instanceDetail.subtitle", { mc: instance.mcVersion, version: instance.versionId }) : undefined}
        width={760}
        onClose={onClose}
      >
        {instance ? (
          <div className="detail-hero">
            <div className="detail-hero-badges">
              <span className="field-label">{tr("pages.instanceDetail.currentLoader")}</span>
              <LoaderBadge loader={instance.loader} />
              <span className="badge detail-version">{instance.loaderVersion ?? tr("pages.instanceDetail.noLoaderVersion")}</span>
            </div>
            <div className="detail-hero-meta">
              <span className="field-label">{tr("pages.instanceDetail.mcVersion")}</span>
              <span className="detail-mc">{instance.mcVersion}</span>
              <span className="detail-disk" data-detail-disk>
                <span data-detail-disk-value>{tr("pages.instanceDetail.localUsage", { size: diskText })}</span>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  data-action="restat-disk"
                  onClick={() => void restatDiskUsage()}
                  disabled={restatting || switching}
                >
                  <IconRefresh size={15} />
                  {restatting ? tr("pages.instanceDetail.restatting") : tr("pages.instanceDetail.restat")}
                </button>
              </span>
            </div>
          </div>
        ) : null}

        <section className="detail-section">
          <div className="drawer-section-head">
            <span className="field-label">{tr("pages.instanceDetail.loaderSection")}</span>
            <span className="muted-text">
              {tr("pages.instanceDetail.loaderSectionHintBefore")}
              <code className="mono">.minecraft/versions</code>
              {tr("pages.instanceDetail.loaderSectionHintAfter")}
            </span>
          </div>

          <div className={`detail-loader-row ${targetLoader === "vanilla" ? "is-vanilla" : ""}`}>
            <div className="field">
              <span className="field-label">{tr("pages.instanceDetail.targetLoader")}</span>
              <Select
                value={targetLoader}
                options={loaderOptions(tr)}
                onChange={(value) => setTargetLoader(value as LoaderKind)}
                ariaLabel={tr("pages.instanceDetail.targetLoader")}
                disabled={switching}
              />
            </div>
            {targetLoader === "vanilla" ? null : (
              <div className="field">
                <span className="field-label">{tr("pages.instanceDetail.loaderVersionLabel")}</span>
                <Select
                  value={targetVersion}
                  options={(loaderVersions.data ?? []).map((item) => ({
                    value: item.version,
                    label: item.stable ? item.version : tr("pages.instanceDetail.versionBeta", { version: item.version }),
                  }))}
                  onChange={setTargetVersion}
                  ariaLabel={tr("pages.instanceDetail.loaderVersionLabel")}
                  placeholder={liteloaderBlocked
                    ? tr("pages.instanceDetail.liteloaderUnsupported")
                    : (loaderVersions.loading ? tr("pages.instanceDetail.reading") : tr("pages.instanceDetail.selectLoaderVersion"))}
                  disabled={switching || loaderVersions.loading || liteloaderBlocked}
                />
                {liteloaderBlocked ? (
                  <span className="field-hint" data-litloader-warning>{liteloaderVersionHint(tr)}</span>
                ) : null}
              </div>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setConfirmSwitch(true)}
              disabled={switching || unchanged || liteloaderBlocked || (targetLoader !== "vanilla" && !targetVersion)}
            >
              {switching ? tr("pages.instanceDetail.switching") : tr("pages.instanceDetail.switchLoader")}
            </button>
          </div>

          {loaderVersions.error && targetLoader !== "vanilla" ? (
            <ErrorState message={loaderVersions.error} onRetry={loaderVersions.reload} />
          ) : null}

          {switching ? (
            <p className="detail-progress" role="status">
              <span className="spinner" aria-hidden="true" />
              {tr("pages.instanceDetail.installingLoader", { target: switchTarget })}
            </p>
          ) : (
            <p className="hint-inline">{tr("pages.instanceDetail.loaderSwitchHint")}</p>
          )}
        </section>

        <section className="detail-section">
          <div className="drawer-section-head">
            <span className="field-label">Java</span>
            <span className="muted-text" data-java-mode>
              {savedJavaPath ? tr("pages.instanceDetail.javaManual") : tr("pages.instanceDetail.javaAutoShort")}
            </span>
          </div>

          <div className="detail-java-row">
            <div className="field">
              <span className="field-label">{tr("pages.instanceDetail.javaRuntime")}</span>
              <Select
                value={javaDraft}
                options={javaOptions}
                onChange={setJavaDraft}
                placeholder={installedJava.loading ? tr("pages.instanceDetail.readingJdk") : tr("pages.instanceDetail.javaAutoShort")}
                ariaLabel={tr("pages.instanceDetail.javaRuntimeAria")}
                disabled={savingJava || installedJava.loading}
              />
              <span className="field-hint detail-java-path" title={javaDraft || tr("pages.instanceDetail.javaPickedByLauncher")}>
                {javaDraft || tr("pages.instanceDetail.javaPickedByLauncher")}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void saveJava(javaDraft)}
              disabled={savingJava || installedJava.loading || javaDraft.trim() === savedJavaPath}
            >
              <IconCheck size={15} />
              {savingJava ? tr("pages.common.saving") : tr("pages.common.save")}
            </button>
          </div>

          {installedJava.error ? <ErrorState message={installedJava.error} onRetry={installedJava.reload} /> : null}

          {javaDraft.trim() === "" ? (
            <p className="hint-inline">{tr("pages.instanceDetail.javaRule")}</p>
          ) : null}

          {javaExists === false ? (
            <div className="detail-java-stale" data-java-stale>
              <div className="detail-java-stale-main">
                <span className="badge detail-java-stale-tag">{tr("pages.instanceDetail.stalePath")}</span>
                <p className="detail-java-stale-path mono" title={savedJavaPath}>{savedJavaPath}</p>
                <p className="field-hint">{tr("pages.instanceDetail.stalePathHint")}</p>
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
                {tr("pages.instanceDetail.clear")}
              </button>
            </div>
          ) : null}

          {settings?.javaAutoMatch === false && savedJavaPath === "" ? (
            <p className="hint-inline">{tr("pages.instanceDetail.javaAutoDisabledHint")}</p>
          ) : null}
        </section>

        <section className="detail-section" data-detail-window>
          <div className="drawer-section-head">
            <span className="field-label">{tr("pages.instanceDetail.windowSection")}</span>
            <span className="muted-text" data-window-mode-current>
              {windowMode === "inherit"
                ? tr("pages.instanceDetail.windowInheritGlobal")
                : windowMode === "fullscreen"
                  ? tr("pages.instanceDetail.windowFullscreen")
                  : tr("pages.instanceDetail.windowWindowed")}
            </span>
          </div>

          <div className="detail-window-row">
            <div className="field">
              <span className="field-label">{tr("pages.instanceDetail.windowMode")}</span>
              <Segmented
                value={windowMode}
                options={WINDOW_MODE_OPTIONS.map((option) => ({ value: option.value, label: tr(option.labelKey) }))}
                onChange={changeWindowMode}
              />
            </div>
            <div className="field">
              <span className="field-label">{tr("pages.instanceDetail.windowSize")}</span>
              <Select
                value={sizeCustom ? "custom" : windowSize}
                options={localizeSizes(WINDOW_SIZE_OPTIONS, tr)}
                onChange={changeWindowSize}
                ariaLabel={tr("pages.instanceDetail.windowSizeAria")}
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
                aria-label={tr("pages.instanceDetail.windowWidthAria")}
                onChange={(event) => setSizeW(event.target.value)}
                disabled={savingWindow || windowMode === "fullscreen"}
              />
              <span className="window-size-x">×</span>
              <TextInput
                type="number"
                min={480}
                max={4320}
                value={sizeH}
                aria-label={tr("pages.instanceDetail.windowHeightAria")}
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
                {tr("pages.instanceDetail.apply")}
              </button>
            </div>
          ) : null}

          {windowMode === "fullscreen" ? (
            <p className="hint-inline" data-window-fullscreen-hint>{tr("pages.instanceDetail.fullscreenHint")}</p>
          ) : null}

          <p className="hint-inline">{tr("pages.instanceDetail.inheritHint")}</p>
        </section>

        <ConfirmDialog
          open={confirmSwitch}
          title={tr("pages.instanceDetail.switchConfirmTitle")}
          message={instance
            ? tr("pages.instanceDetail.switchConfirmMessage", { name: instance.name, target: switchTarget })
            : ""}
          confirmText={tr("pages.instanceDetail.switchConfirmAction")}
          busy={switching}
          onCancel={() => setConfirmSwitch(false)}
          onConfirm={() => void applyLoader()}
        />
      </Drawer>
    </>
  );
}