import { useEffect, useMemo, useRef, useState } from "react";
import type { InstanceMeta, LoaderKind, Settings, VersionBrief } from "../../shared/types";
import { api } from "../lib/api";
import { LITELOADER_VERSION_HINT, loaderLabel, liteloaderUnsupported } from "../lib/format";
import { usePersist } from "../lib/persist";
import { useApp } from "../lib/store";
import { useAsync, errorMessage } from "../lib/useAsync";
import { useToast } from "./Toast";
import { Modal } from "./Modal";
import { Field, Select, Slider, TextInput } from "./Form";

const LOADERS: Array<{ value: LoaderKind; label: string }> = [
  { value: "vanilla", label: "原版" },
  { value: "fabric", label: "Fabric" },
  { value: "quilt", label: "Quilt" },
  { value: "forge", label: "Forge" },
  { value: "neoforge", label: "NeoForge" },
  { value: "liteloader", label: "LiteLoader" },
];

const memoryLabel = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

type TypeFilterKey = "showRelease" | "showSnapshot" | "showLegacy";

/** 与下载页同一组 settings 布尔：正式版 / 测试版（快照）/ 远古版。 */
const TYPE_FILTERS: Array<{ key: TypeFilterKey; label: string; detail: string }> = [
  { key: "showRelease", label: "正式版", detail: "release" },
  { key: "showSnapshot", label: "测试版", detail: "snapshot 快照" },
  { key: "showLegacy", label: "远古版", detail: "old_beta / old_alpha" },
];

export function CreateInstanceModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (instance: InstanceMeta) => void;
}) {
  const { versions, reloadVersions, settings } = useApp();
  const { push } = useToast();
  const persist = usePersist();
  const [name, setName] = useState("");
  const [mcVersion, setMcVersion] = useState("");
  const [loader, setLoader] = useState<LoaderKind>("vanilla");
  const [loaderVersion, setLoaderVersion] = useState("");
  const [memoryMb, setMemoryMb] = useState(4096);
  const [busy, setBusy] = useState(false);
  const [autoNote, setAutoNote] = useState<string | null>(null);

  // 默认全勾：settings 里没有值时按 true 处理。
  const showRelease = settings?.showRelease ?? true;
  const showSnapshot = settings?.showSnapshot ?? true;
  const showLegacy = settings?.showLegacy ?? true;
  const typeChecked: Record<TypeFilterKey, boolean> = { showRelease, showSnapshot, showLegacy };
  // 打开弹窗时的一次性初始化只按当时最新的勾选取默认值，不因勾选变化重跑重置逻辑。
  const flagsRef = useRef({ showRelease, showSnapshot, showLegacy });
  flagsRef.current = { showRelease, showSnapshot, showLegacy };

  const persistType = (key: TypeFilterKey, value: boolean) => {
    const label = TYPE_FILTERS.find((item) => item.key === key)?.label ?? key;
    const patch: Partial<Settings> = key === "showRelease"
      ? { showRelease: value }
      : key === "showSnapshot"
        ? { showSnapshot: value }
        : { showLegacy: value };
    void persist(patch, `${label}显示`);
  };

  const visibleVersions = useMemo(() => {
    const visible = (type: VersionBrief["type"]) => (type === "release"
      ? showRelease
      : type === "snapshot"
        ? showSnapshot
        : showLegacy);
    return (versions ?? []).filter((item) => visible(item.type));
  }, [versions, showRelease, showSnapshot, showLegacy]);

  const versionOptions = useMemo(() => {
    const releases = visibleVersions.filter((item) => item.type === "release");
    const others = visibleVersions.filter((item) => item.type !== "release");
    return [
      ...releases.map((item) => ({ value: item.id, label: item.id })),
      ...others.map((item) => ({
        value: item.id,
        label: `${item.id}（${item.type === "snapshot" ? "测试版" : "远古版"}）`,
      })),
    ];
  }, [visibleVersions]);

  // LiteLoader 只到 1.12.2：更高版本直接不发请求，避免主进程返回「版本不支持」的错误态。
  const liteloaderBlocked = loader === "liteloader" && liteloaderUnsupported(mcVersion);

  const { data: loaderVersions, loading: loaderLoading, error: loaderError } = useAsync(
    () => (open && loader !== "vanilla" && !liteloaderBlocked && mcVersion
      ? api.versions.loaders(mcVersion, loader)
      : Promise.resolve([])),
    [open, loader, mcVersion],
  );

  useEffect(() => {
    if (!open) return;
    const flags = flagsRef.current;
    const visible = (type: VersionBrief["type"]) => (type === "release"
      ? flags.showRelease
      : type === "snapshot"
        ? flags.showSnapshot
        : flags.showLegacy);
    const candidates = (versions ?? []).filter((item) => visible(item.type));
    setName("");
    setLoader("vanilla");
    setLoaderVersion("");
    setMemoryMb(4096);
    setAutoNote(null);
    setMcVersion(candidates.find((item) => item.type === "release")?.id ?? candidates[0]?.id ?? "");
  }, [open, versions]);

  // 勾选变化后若当前选中版本被过滤掉，自动改选列表第一个可选版本并给一行提示。
  const mcVersionRef = useRef(mcVersion);
  mcVersionRef.current = mcVersion;
  const prevOptionsRef = useRef(versionOptions);
  useEffect(() => {
    if (prevOptionsRef.current === versionOptions) return;
    prevOptionsRef.current = versionOptions;
    const current = mcVersionRef.current;
    if (versionOptions.some((option) => option.value === current)) {
      setAutoNote(null);
      return;
    }
    const first = versionOptions[0]?.value ?? "";
    if (open && current !== "") {
      setAutoNote(first
        ? `已选版本 ${current} 不在当前勾选的版本类型内，已自动改选 ${first}`
        : "当前勾选下没有任何可选版本，请至少勾选一种版本类型");
    }
    setMcVersion(first);
  }, [open, versionOptions]);

  useEffect(() => {
    if (loader === "vanilla" || liteloaderBlocked) {
      setLoaderVersion("");
      return;
    }
    if (!loaderVersions || loaderVersions.length === 0) {
      setLoaderVersion("");
      return;
    }
    const preferred = loaderVersions.find((item) => item.stable) ?? loaderVersions[0];
    setLoaderVersion(preferred.version);
  }, [loader, loaderVersions, liteloaderBlocked]);

  const submit = async () => {
    if (!mcVersion) {
      push("请先选择 Minecraft 版本", "error");
      return;
    }
    if (liteloaderBlocked) {
      push(LITELOADER_VERSION_HINT, "error");
      return;
    }
    setBusy(true);
    try {
      const created = await api.instances.create({
        name: name.trim() || `${mcVersion} ${loaderLabel(loader)}`,
        mcVersion,
        loader,
        loaderVersion: loader === "vanilla" ? undefined : loaderVersion || undefined,
        memoryMb,
      });
      push(`实例「${created.name}」已创建`, "success");
      onCreated(created);
      onClose();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="新建实例"
      subtitle="下载游戏本体与加载器，装好后即可启动"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={busy || !mcVersion || liteloaderBlocked}
            title={liteloaderBlocked ? LITELOADER_VERSION_HINT : undefined}
            data-create-blocked={liteloaderBlocked ? "liteloader" : undefined}
          >
            {busy ? "创建中…" : "创建实例"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="实例名称" hint="留空则按「版本 + 加载器」自动命名">
          <TextInput
            value={name}
            placeholder={`${mcVersion || "1.21.4"} ${loaderLabel(loader)}`}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="版本类型" hint="与下载页共用同一组设置，只影响这里的版本候选">
          <div className="version-type-filter" data-version-type-filter="modal">
            {TYPE_FILTERS.map((filter) => (
              <label key={filter.key} className="checkline" title={`${filter.label}（${filter.detail}）`}>
                <input
                  type="checkbox"
                  aria-label={filter.label}
                  checked={typeChecked[filter.key]}
                  onChange={(event) => persistType(filter.key, event.target.checked)}
                />
                <span>{filter.label}</span>
              </label>
            ))}
          </div>
        </Field>

        <Field label="Minecraft 版本" hint={versions === null ? "正在读取版本清单…" : undefined}>
          {versions === null ? (
            <button type="button" className="btn btn-ghost" onClick={() => void reloadVersions(true)}>
              读取版本清单
            </button>
          ) : (
            <Select
              value={mcVersion}
              options={versionOptions}
              onChange={(value) => {
                setMcVersion(value);
                setAutoNote(null);
              }}
              ariaLabel="Minecraft 版本"
              placeholder="请选择版本"
            />
          )}
          {autoNote ? <span className="field-hint" data-version-auto-note>{autoNote}</span> : null}
        </Field>

        <Field label="加载器">
          <Select
            value={loader}
            options={LOADERS}
            onChange={(value) => setLoader(value as LoaderKind)}
            ariaLabel="加载器"
          />
        </Field>

        {loader === "vanilla" ? null : (
          <Field
            label="加载器版本"
            hint={liteloaderBlocked
              ? LITELOADER_VERSION_HINT
              : (loaderError ?? (loaderLoading ? "读取加载器版本…" : undefined))}
          >
            <Select
              value={loaderVersion}
              options={(loaderVersions ?? []).map((item) => ({
                value: item.version,
                label: item.stable ? item.version : `${item.version}（测试版）`,
              }))}
              onChange={setLoaderVersion}
              ariaLabel="加载器版本"
              placeholder={liteloaderBlocked
                ? "该 MC 版本不支持 LiteLoader"
                : (loaderLoading ? "读取中…" : "请选择加载器版本")}
              disabled={loaderLoading || liteloaderBlocked}
            />
          </Field>
        )}

        <Field label="内存分配">
          <Slider value={memoryMb} min={1024} max={16384} step={512} onChange={setMemoryMb} format={memoryLabel} />
        </Field>
      </div>
    </Modal>
  );
}

export function EditInstanceModal({
  instance, open, onClose, onSaved,
}: {
  instance: InstanceMeta | null;
  open: boolean;
  onClose: () => void;
  onSaved: (instance: InstanceMeta) => void;
}) {
  const { push } = useToast();
  const [name, setName] = useState("");
  const [memoryMb, setMemoryMb] = useState(4096);
  const [extraJvmArgs, setExtraJvmArgs] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !instance) return;
    setName(instance.name);
    setMemoryMb(instance.memoryMb);
    setExtraJvmArgs(instance.extraJvmArgs);
  }, [open, instance]);

  const save = async () => {
    if (!instance) return;
    if (!name.trim()) {
      push("实例名称不能为空", "error");
      return;
    }
    setBusy(true);
    try {
      const updated = await api.instances.update(instance.id, { name: name.trim(), memoryMb, extraJvmArgs });
      push("实例设置已保存", "success");
      onSaved(updated);
      onClose();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="实例设置"
      subtitle={instance ? `${instance.mcVersion} · ${loaderLabel(instance.loader)} · ${instance.versionId}` : undefined}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="实例名称">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="内存分配">
          <Slider value={memoryMb} min={1024} max={16384} step={512} onChange={setMemoryMb} format={memoryLabel} />
        </Field>
        <Field label="额外 JVM 参数" hint="例如 -XX:+UseG1GC，留空则使用默认参数">
          <TextInput
            value={extraJvmArgs}
            placeholder="-XX:+UseG1GC"
            onChange={(event) => setExtraJvmArgs(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
