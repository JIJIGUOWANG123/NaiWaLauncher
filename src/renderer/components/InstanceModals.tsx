import { useEffect, useMemo, useRef, useState } from "react";
import type { InstanceMeta, LoaderKind, Settings, VersionBrief } from "../../shared/types";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { loaderLabel, liteloaderUnsupported, liteloaderVersionHint } from "../lib/format";
import { usePersist } from "../lib/persist";
import { useApp } from "../lib/store";
import { useAsync, errorMessage } from "../lib/useAsync";
import { useToast } from "./Toast";
import { Modal } from "./Modal";
import { Field, Select, Slider, TextInput } from "./Form";

type Translator = (key: string, vars?: Record<string, string | number>) => string;

/** 加载器下拉：原版走词典，其余是专有名词，保持英文。 */
function loaderOptions(tr: Translator): Array<{ value: LoaderKind; label: string }> {
  return [
    { value: "vanilla", label: tr("pages.instanceModals.loaderVanilla") },
    { value: "fabric", label: "Fabric" },
    { value: "quilt", label: "Quilt" },
    { value: "forge", label: "Forge" },
    { value: "neoforge", label: "NeoForge" },
    { value: "liteloader", label: "LiteLoader" },
  ];
}

const memoryLabel = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

type TypeFilterKey = "showRelease" | "showSnapshot" | "showLegacy";

/** 与下载页同一组 settings 布尔：正式版 / 测试版（快照）/ 远古版。 */
const TYPE_FILTERS: Array<{ key: TypeFilterKey; labelKey: string; detail: string }> = [
  { key: "showRelease", labelKey: "pages.instanceModals.typeRelease", detail: "release" },
  { key: "showSnapshot", labelKey: "pages.instanceModals.typeSnapshot", detail: "snapshot" },
  { key: "showLegacy", labelKey: "pages.instanceModals.typeLegacy", detail: "old_beta / old_alpha" },
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
  const tr = useT();
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
    const label = tr(TYPE_FILTERS.find((item) => item.key === key)?.labelKey ?? key);
    const patch: Partial<Settings> = key === "showRelease"
      ? { showRelease: value }
      : key === "showSnapshot"
        ? { showSnapshot: value }
        : { showLegacy: value };
    void persist(patch, tr("pages.download.persistShow", { label }));
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
        label: tr("pages.instanceModals.versionOption", {
          id: item.id,
          type: tr(item.type === "snapshot" ? "pages.instanceModals.typeSnapshot" : "pages.instanceModals.typeLegacy"),
        }),
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
        ? tr("pages.instanceModals.autoSwitched", { current, next: first })
        : tr("pages.instanceModals.autoEmpty"));
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
      push(tr("pages.instanceModals.errNoVersion"), "error");
      return;
    }
    if (liteloaderBlocked) {
      push(liteloaderVersionHint(tr), "error");
      return;
    }
    setBusy(true);
    try {
      const created = await api.instances.create({
        name: name.trim() || `${mcVersion} ${loaderLabel(loader, tr)}`,
        mcVersion,
        loader,
        loaderVersion: loader === "vanilla" ? undefined : loaderVersion || undefined,
        memoryMb,
      });
      push(tr("pages.instanceModals.created", { name: created.name }), "success");
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
      title={tr("pages.instanceModals.createTitle")}
      subtitle={tr("pages.instanceModals.createSubtitle")}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {tr("pages.common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={busy || !mcVersion || liteloaderBlocked}
            title={liteloaderBlocked ? liteloaderVersionHint(tr) : undefined}
            data-create-blocked={liteloaderBlocked ? "liteloader" : undefined}
          >
            {busy ? tr("pages.instanceModals.creating") : tr("pages.instanceModals.createAction")}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={tr("pages.instanceModals.nameLabel")} hint={tr("pages.instanceModals.nameHint")}>
          <TextInput
            value={name}
            placeholder={`${mcVersion || "1.21.4"} ${loaderLabel(loader, tr)}`}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label={tr("pages.instanceModals.typeLabel")} hint={tr("pages.instanceModals.typeHint")}>
          <div className="version-type-filter" data-version-type-filter="modal">
            {TYPE_FILTERS.map((filter) => (
              <label
                key={filter.key}
                className="checkline"
                title={tr("pages.instanceModals.typeTitle", { label: tr(filter.labelKey), detail: filter.detail })}
              >
                <input
                  type="checkbox"
                  aria-label={tr(filter.labelKey)}
                  checked={typeChecked[filter.key]}
                  onChange={(event) => persistType(filter.key, event.target.checked)}
                />
                <span>{tr(filter.labelKey)}</span>
              </label>
            ))}
          </div>
        </Field>

        <Field label={tr("pages.instanceModals.mcVersionLabel")} hint={versions === null ? tr("pages.instanceModals.readingVersions") : undefined}>
          {versions === null ? (
            <button type="button" className="btn btn-ghost" onClick={() => void reloadVersions(true)}>
              {tr("pages.instanceModals.loadVersions")}
            </button>
          ) : (
            <Select
              value={mcVersion}
              options={versionOptions}
              onChange={(value) => {
                setMcVersion(value);
                setAutoNote(null);
              }}
              ariaLabel={tr("pages.instanceModals.mcVersionLabel")}
              placeholder={tr("pages.instanceModals.selectVersion")}
            />
          )}
          {autoNote ? <span className="field-hint" data-version-auto-note>{autoNote}</span> : null}
        </Field>

        <Field label={tr("pages.instanceModals.loader")}>
          <Select
            value={loader}
            options={loaderOptions(tr)}
            onChange={(value) => setLoader(value as LoaderKind)}
            ariaLabel={tr("pages.instanceModals.loader")}
          />
        </Field>

        {loader === "vanilla" ? null : (
          <Field
            label={tr("pages.instanceModals.loaderVersionLabel")}
            hint={liteloaderBlocked
              ? liteloaderVersionHint(tr)
              : (loaderError ?? (loaderLoading ? tr("pages.instanceModals.readingLoaderVersions") : undefined))}
          >
            <Select
              value={loaderVersion}
              options={(loaderVersions ?? []).map((item) => ({
                value: item.version,
                label: item.stable ? item.version : tr("pages.instanceModals.versionBeta", { version: item.version }),
              }))}
              onChange={setLoaderVersion}
              ariaLabel={tr("pages.instanceModals.loaderVersionLabel")}
              placeholder={liteloaderBlocked
                ? tr("pages.instanceModals.liteloaderUnsupported")
                : (loaderLoading ? tr("pages.instanceModals.reading") : tr("pages.instanceModals.selectLoaderVersion"))}
              disabled={loaderLoading || liteloaderBlocked}
            />
          </Field>
        )}

        <Field label={tr("pages.instanceModals.memory")}>
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
  const tr = useT();
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
      push(tr("pages.instanceModals.errEmptyName"), "error");
      return;
    }
    setBusy(true);
    try {
      const updated = await api.instances.update(instance.id, { name: name.trim(), memoryMb, extraJvmArgs });
      push(tr("pages.instanceModals.editSaved"), "success");
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
      title={tr("pages.instanceModals.editTitle")}
      subtitle={instance ? `${instance.mcVersion} · ${loaderLabel(instance.loader, tr)} · ${instance.versionId}` : undefined}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {tr("pages.common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? tr("pages.common.saving") : tr("pages.common.save")}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={tr("pages.instanceModals.nameLabel")}>
          <TextInput value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={tr("pages.instanceModals.memory")}>
          <Slider value={memoryMb} min={1024} max={16384} step={512} onChange={setMemoryMb} format={memoryLabel} />
        </Field>
        <Field label={tr("pages.instanceModals.extraJvm")} hint={tr("pages.instanceModals.extraJvmHint")}>
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
