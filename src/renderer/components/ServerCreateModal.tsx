import { useEffect, useMemo, useState } from "react";
import type { ServerCoreId, ServerEntry } from "../../shared/types";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "./Toast";
import { Modal } from "./Modal";
import { Field, Select, Slider, TextInput, Toggle } from "./Form";

/** FastMirror 的 tag 是英文 id，界面上要换成对应语言的说明。 */
const TAG_KEY: Record<string, string> = {
  pure: "pages.server.tagPlugin",
  mod: "pages.server.tagModded",
  vanilla: "pages.server.tagVanilla",
};

const DEFAULT_PORT = "25565";
const DEFAULT_MEMORY = 2048;
const DEFAULT_MAX_PLAYERS = "20";

/**
 * 新建服务端：核心 → 游戏版本 → 构建 三级联动，默认值按 FastMirror 的推荐排序自动带出来。
 * 只负责收集参数并调用 servers.create，落盘与下载都在主进程。
 */
export function ServerCreateModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (entry: ServerEntry) => void;
}) {
  const { push } = useToast();
  const t = useT();
  const [core, setCore] = useState<ServerCoreId | "">("");
  const [mcVersion, setMcVersion] = useState("");
  const [coreVersion, setCoreVersion] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [port, setPort] = useState(DEFAULT_PORT);
  const [memoryMb, setMemoryMb] = useState(DEFAULT_MEMORY);
  const [maxPlayers, setMaxPlayers] = useState(DEFAULT_MAX_PLAYERS);
  const [onlineMode, setOnlineMode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cores = useAsync(() => (open ? api.servers.cores() : Promise.resolve([])), [open]);
  const selectedCore = useMemo(
    () => (cores.data ?? []).find((item) => item.core === core) ?? null,
    [core, cores.data],
  );
  const builds = useAsync(
    () => (open && core && mcVersion ? api.servers.builds(core, mcVersion) : Promise.resolve([])),
    [open, core, mcVersion],
  );

  // 打开时把核心默认到推荐项（Paper / Fabric 之类），关掉后不清空，方便再次打开看到上次的选择。
  useEffect(() => {
    if (!open) return;
    const list = cores.data ?? [];
    if (list.length === 0) return;
    setCore((prev) => (prev && list.some((item) => item.core === prev) ? prev : (list.find((item) => item.recommend) ?? list[0]).core));
  }, [cores.data, open]);

  // 换核心后游戏版本回到该核心支持的最新一个。
  useEffect(() => {
    if (!open || !selectedCore) return;
    setMcVersion((prev) => (selectedCore.mcVersions.includes(prev) ? prev : selectedCore.mcVersions[0] ?? ""));
  }, [open, selectedCore]);

  // 换版本后构建回到最新一条。
  useEffect(() => {
    if (!open || !core || !mcVersion) return;
    const list = builds.data ?? [];
    setCoreVersion((prev) => (prev && list.some((item) => item.coreVersion === prev) ? prev : list[0]?.coreVersion ?? ""));
  }, [builds.data, core, mcVersion, open]);

  // 名称没被手动改过时，跟着核心 + 版本自动填一个。
  useEffect(() => {
    if (!open || nameTouched) return;
    if (!core || !mcVersion) return;
    setName(`${core} ${mcVersion}`);
  }, [core, mcVersion, nameTouched, open]);

  const coreOptions = useMemo(
    () => (cores.data ?? []).map((item) => ({
      value: item.core,
      label: `${item.core} (${item.tag in TAG_KEY ? t(TAG_KEY[item.tag]) : item.tag})`,
      title: item.homepage,
    })),
    [cores.data, t],
  );
  const versionOptions = useMemo(
    () => (selectedCore?.mcVersions ?? []).map((version) => ({ value: version, label: version })),
    [selectedCore],
  );
  const buildOptions = useMemo(
    () => (builds.data ?? []).map((item) => ({
      value: item.coreVersion,
      label: `${item.coreVersion} · ${item.updateTime}`,
      title: item.sha1,
    })),
    [builds.data],
  );

  const submit = async () => {
    if (!core || !mcVersion || !coreVersion) {
      setError(t("pages.serverCreate.needSelection"));
      return;
    }
    const portNum = Number(port);
    const maxNum = Number(maxPlayers);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError(t("pages.server.portInvalid"));
      return;
    }
    if (!Number.isInteger(maxNum) || maxNum < 1 || maxNum > 1000) {
      setError(t("pages.server.maxPlayersInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const entry = await api.servers.create({
        name: name.trim() || `${core} ${mcVersion}`,
        core,
        mcVersion,
        coreVersion,
        port: portNum,
        memoryMb,
        maxPlayers: maxNum,
        onlineMode,
      });
      push(t("pages.serverCreate.created", { name: entry.meta.name }), "success");
      onCreated(entry);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("pages.server.create")}
      subtitle={t("pages.serverCreate.subtitle")}
      width={560}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t("pages.server.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-action="server-create-submit"
            onClick={() => void submit()}
            disabled={busy || cores.loading || builds.loading || !coreVersion}
          >
            {busy ? t("pages.serverCreate.creating") : t("pages.serverCreate.createAndDownload")}
          </button>
        </>
      )}
    >
      <div className="form-grid">
      <Field label={t("pages.server.name")} hint={t("pages.serverCreate.nameHint")}>
        <TextInput
          value={name}
          maxLength={40}
          placeholder={t("pages.serverCreate.namePlaceholder")}
          aria-label={t("pages.server.nameAria")}
          onChange={(event) => {
            setName(event.target.value);
            setNameTouched(true);
          }}
        />
      </Field>

      <Field label={t("pages.serverCreate.core")} hint={cores.error ?? t("pages.serverCreate.coreHint")}>
        <Select
          value={core}
          options={coreOptions}
          onChange={(value) => setCore(value as ServerCoreId)}
          ariaLabel={t("pages.serverCreate.coreAria")}
          placeholder={cores.loading ? t("pages.serverCreate.readingCores") : t("pages.serverCreate.chooseCore")}
          disabled={cores.loading || busy}
        />
      </Field>

      <Field label={t("pages.serverCreate.gameVersion")} hint={t("pages.serverCreate.gameVersionHint")}>
        <Select
          value={mcVersion}
          options={versionOptions}
          onChange={setMcVersion}
          ariaLabel={t("pages.serverCreate.gameVersionAria")}
          placeholder={core ? t("pages.serverCreate.chooseGameVersion") : t("pages.serverCreate.chooseCoreFirst")}
          disabled={!core || busy}
        />
      </Field>

      <Field
        label={t("pages.server.build")}
        hint={builds.loading
          ? t("pages.serverCreate.readingBuilds")
          : (builds.error ?? t("pages.serverCreate.buildHint"))}
      >
        <Select
          value={coreVersion}
          options={buildOptions}
          onChange={setCoreVersion}
          ariaLabel={t("pages.serverCreate.buildAria")}
          placeholder={mcVersion ? t("pages.serverCreate.chooseBuild") : t("pages.serverCreate.chooseVersionFirst")}
          disabled={!mcVersion || builds.loading || busy}
        />
      </Field>

      <div className="server-form-row">
        <Field label={t("pages.server.port")} hint={t("pages.serverCreate.portHint")}>
          <TextInput
            type="number"
            min={1}
            max={65535}
            value={port}
            aria-label={t("pages.server.port")}
            onChange={(event) => setPort(event.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label={t("pages.server.maxPlayers")} hint={t("pages.serverCreate.maxPlayersHint")}>
          <TextInput
            type="number"
            min={1}
            max={1000}
            value={maxPlayers}
            aria-label={t("pages.server.maxPlayers")}
            onChange={(event) => setMaxPlayers(event.target.value)}
            disabled={busy}
          />
        </Field>
      </div>

      <Field label={t("pages.server.memory")} hint={t("pages.serverCreate.memoryHint")}>
        <Slider
          value={memoryMb}
          min={512}
          max={16384}
          step={512}
          onChange={setMemoryMb}
          format={(value) => `${value} MB`}
          disabled={busy}
        />
      </Field>

      <Toggle
        checked={onlineMode}
        onChange={setOnlineMode}
        label={t("pages.server.onlineMode")}
        hint={t("pages.server.onlineModeHint")}
      />

      <p className="server-form-note">{t("pages.serverCreate.note")}</p>
      {error ? <p className="server-form-error" data-server-create-error>{error}</p> : null}
      </div>
    </Modal>
  );
}
