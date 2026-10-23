import { useCallback, useEffect, useState } from "react";
import type { ServerCoreId, ServerEntry, ServerStatus } from "../../shared/types";
import { api } from "../lib/api";
import { formatRelative } from "../lib/format";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { ConfirmDialog, Modal } from "../components/Modal";
import { Field, Slider, TextInput, Toggle } from "../components/Form";
import { EmptyState, ErrorState, SkeletonCards } from "../components/State";
import { ServerConsole } from "../components/ServerConsole";
import { ServerCreateModal } from "../components/ServerCreateModal";
import { IconList, IconPause, IconPlay, IconPlus, IconRefresh, IconSettings } from "../components/icons";

const STATUS_KEY: Record<ServerStatus, string> = {
  stopped: "pages.server.statusStopped",
  starting: "pages.server.statusStarting",
  running: "pages.server.statusRunning",
  stopping: "pages.server.statusStopping",
  crashed: "pages.server.statusCrashed",
};

/** 卡片上的分类：与 cores() 的 tag 同义，只是 ServerEntry 里没有 tag 字段，按核心名映射到 i18n key。 */
const CORE_TAG_KEY: Record<ServerCoreId, string> = {
  Vanilla: "pages.server.tagVanilla",
  Paper: "pages.server.tagPlugin",
  Purpur: "pages.server.tagPlugin",
  Folia: "pages.server.tagPlugin",
  Fabric: "pages.server.tagModded",
  Forge: "pages.server.tagModded",
  NeoForge: "pages.server.tagModded",
  Arclight: "pages.server.tagModded",
};

/** 设置弹窗：改名称/端口/内存/人数/正版验证，删除入口也在这里（删除由外层二次确认）。 */
function ServerSettingsModal({
  open, entry, onClose, onSaved, onDelete,
}: {
  open: boolean;
  entry: ServerEntry | null;
  onClose: () => void;
  onSaved: (entry: ServerEntry) => void;
  onDelete: (entry: ServerEntry) => void;
}) {
  const { push } = useToast();
  const t = useT();
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [memoryMb, setMemoryMb] = useState(2048);
  const [maxPlayers, setMaxPlayers] = useState("");
  const [onlineMode, setOnlineMode] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都从当前元数据回填，避免上一次的草稿残留。
  useEffect(() => {
    if (!open || !entry) return;
    setName(entry.meta.name);
    setPort(String(entry.meta.port));
    setMemoryMb(entry.meta.memoryMb);
    setMaxPlayers(String(entry.meta.maxPlayers));
    setOnlineMode(entry.meta.onlineMode);
    setError(null);
  }, [entry, open]);

  const save = async () => {
    if (!entry) return;
    const portNum = Number(port);
    const maxNum = Number(maxPlayers);
    if (!name.trim()) {
      setError(t("pages.server.nameRequired"));
      return;
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError(t("pages.server.portInvalid"));
      return;
    }
    if (!Number.isInteger(maxNum) || maxNum < 1 || maxNum > 1000) {
      setError(t("pages.server.maxPlayersInvalid"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await api.servers.update(entry.meta.id, {
        name: name.trim(),
        port: portNum,
        memoryMb,
        maxPlayers: maxNum,
        onlineMode,
      });
      push(t("pages.server.saved"), "success");
      onSaved(next);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open && entry !== null}
      title={t("pages.server.settingsTitle")}
      subtitle={entry ? `${entry.meta.core} ${entry.meta.coreVersion} · Minecraft ${entry.meta.mcVersion}` : undefined}
      width={520}
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={(
        <>
          <button
            type="button"
            className="btn btn-danger-ghost"
            data-action="server-delete"
            onClick={() => {
              if (entry) onDelete(entry);
            }}
            disabled={saving}
          >
            {t("pages.server.delete")}
          </button>
          <span className="modal-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            {t("pages.server.cancel")}
          </button>
          <button type="button" className="btn btn-primary" data-action="server-save" onClick={() => void save()} disabled={saving}>
            {saving ? t("pages.server.saving") : t("pages.server.save")}
          </button>
        </>
      )}
    >
      <div className="form-grid">
      <Field label={t("pages.server.name")}>
        <TextInput value={name} maxLength={40} aria-label={t("pages.server.nameAria")} onChange={(event) => setName(event.target.value)} disabled={saving} />
      </Field>
      <div className="server-form-row">
        <Field label={t("pages.server.port")} hint={t("pages.server.portHint")}>
          <TextInput
            type="number"
            min={1}
            max={65535}
            value={port}
            aria-label={t("pages.server.port")}
            onChange={(event) => setPort(event.target.value)}
            disabled={saving}
          />
        </Field>
        <Field label={t("pages.server.maxPlayers")}>
          <TextInput
            type="number"
            min={1}
            max={1000}
            value={maxPlayers}
            aria-label={t("pages.server.maxPlayers")}
            onChange={(event) => setMaxPlayers(event.target.value)}
            disabled={saving}
          />
        </Field>
      </div>
      <Field label={t("pages.server.memory")} hint={t("pages.server.memoryHint")}>
        <Slider value={memoryMb} min={512} max={16384} step={512} onChange={setMemoryMb} format={(value) => `${value} MB`} disabled={saving} />
      </Field>
      <Toggle
        checked={onlineMode}
        onChange={setOnlineMode}
        label={t("pages.server.onlineMode")}
        hint={t("pages.server.onlineModeHint")}
      />
      <p className="server-form-note">{t("pages.server.deleteNote")}</p>
      {error ? <p className="server-form-error" data-server-settings-error>{error}</p> : null}
      </div>
    </Modal>
  );
}

/**
 * 开服页：服务端列表（每台独立管理）+ 新建 + 控制台 + 设置。
 * 列表状态由主进程推送（onStatus），启动/停止后卡片立刻跟着变。
 */
export function ServerPage() {
  const { push } = useToast();
  const t = useT();
  const [servers, setServers] = useState<ServerEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [consoleId, setConsoleId] = useState<string | null>(null);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServerEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setServers(await api.servers.list());
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 主进程推送整份列表快照：启动/停止/崩溃都会让卡片当场变色。
  useEffect(() => {
    const off = api.servers.onStatus((entries) => setServers(entries));
    return off;
  }, []);

  const consoleServer = servers?.find((item) => item.meta.id === consoleId) ?? null;
  const settingsServer = servers?.find((item) => item.meta.id === settingsId) ?? null;

  /** 后端只返回单个服务端，用返回值先就地替换，onStatus 到了再整体覆盖。 */
  const replaceEntry = (entry: ServerEntry) => {
    setServers((prev) => prev?.map((item) => (item.meta.id === entry.meta.id ? entry : item)) ?? prev);
  };

  const start = async (entry: ServerEntry) => {
    setBusyId(entry.meta.id);
    try {
      replaceEntry(await api.servers.start(entry.meta.id));
      push(t("pages.server.started", { name: entry.meta.name }), "success");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setBusyId(null);
    }
  };

  const stop = async (entry: ServerEntry) => {
    setBusyId(entry.meta.id);
    try {
      replaceEntry(await api.servers.stop(entry.meta.id));
      push(t("pages.server.stopped", { name: entry.meta.name }), "info");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.servers.remove(deleteTarget.meta.id);
      push(t("pages.server.deleted", { name: deleteTarget.meta.name }), "success");
      setServers((prev) => prev?.filter((item) => item.meta.id !== deleteTarget.meta.id) ?? prev);
      setDeleteTarget(null);
      setSettingsId(null);
      if (consoleId === deleteTarget.meta.id) setConsoleId(null);
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="page server-page" data-server-page>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("pages.server.title")}</h1>
          <p className="page-sub">{t("pages.server.sub")}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void load()} disabled={loading}>
            <IconRefresh size={16} />
            {t("pages.server.refresh")}
          </button>
          <button type="button" className="btn btn-primary" data-action="server-create" onClick={() => setCreateOpen(true)}>
            <IconPlus size={16} />
            {t("pages.server.create")}
          </button>
        </div>
      </header>

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {!error && loading && servers === null ? <SkeletonCards count={3} /> : null}

      {!error && servers !== null && servers.length === 0 ? (
        <EmptyState
          title={t("pages.server.emptyTitle")}
          hint={t("pages.server.emptyHint")}
          action={(
            <button type="button" className="btn btn-primary" data-action="server-create" onClick={() => setCreateOpen(true)}>
              <IconPlus size={16} />
              {t("pages.server.create")}
            </button>
          )}
        />
      ) : null}

      {servers !== null && servers.length > 0 ? (
        <div className="server-grid">
          {servers.map((entry) => {
            const meta = entry.meta;
            const running = entry.status === "running" || entry.status === "starting";
            const stopped = entry.status === "stopped" || entry.status === "crashed";
            const busy = busyId === meta.id;
            return (
              <article
                key={meta.id}
                className="server-card"
                data-server-card={meta.id}
                data-server-core={meta.core}
              >
                <div className="server-card-top">
                  <span className="server-core-badge">{meta.core}</span>
                  <div className="server-card-titles">
                    <h2 className="server-card-name" title={meta.name}>{meta.name}</h2>
                    <p className="server-card-meta">
                      <span className={`server-status is-${entry.status}`} data-server-status={entry.status}>
                        {t(STATUS_KEY[entry.status])}
                      </span>
                      <span className="server-card-meta-item">Minecraft {meta.mcVersion}</span>
                      <span className="server-card-meta-item">{t(CORE_TAG_KEY[meta.core])}</span>
                    </p>
                  </div>
                </div>

                <dl className="server-facts">
                  <div>
                    <dt>{t("pages.server.build")}</dt>
                    <dd title={meta.coreVersion}>{meta.coreVersion}</dd>
                  </div>
                  <div>
                    <dt>{t("pages.server.port")}</dt>
                    <dd>{meta.port}</dd>
                  </div>
                  <div>
                    <dt>{t("pages.server.memory")}</dt>
                    <dd>{meta.memoryMb} MB</dd>
                  </div>
                  <div>
                    <dt>{t("pages.server.lastStarted")}</dt>
                    <dd>{meta.lastStartedAt ? formatRelative(meta.lastStartedAt, t) : t("pages.server.neverStarted")}</dd>
                  </div>
                </dl>

                <div className="server-actions">
                  <button
                    type="button"
                    className="btn btn-primary server-play"
                    data-action="server-start"
                    onClick={() => void start(entry)}
                    disabled={busy || !stopped}
                  >
                    <IconPlay size={15} />
                    {busy && stopped ? t("pages.server.starting") : t("pages.server.start")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-action="server-stop"
                    onClick={() => void stop(entry)}
                    disabled={busy || !running}
                  >
                    <IconPause size={15} />
                    {busy && running ? t("pages.server.stopping") : t("pages.server.stop")}
                  </button>
                  <button type="button" className="btn btn-ghost" data-action="server-console" onClick={() => setConsoleId(meta.id)}>
                    <IconList size={15} />
                    {t("pages.server.console")}
                  </button>
                  <button type="button" className="btn btn-ghost" data-action="server-settings" onClick={() => setSettingsId(meta.id)}>
                    <IconSettings size={15} />
                    {t("pages.server.settings")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      <ServerCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(entry) => {
          replaceEntry(entry);
          setCreateOpen(false);
          // 新建完直接打开控制台，方便看下载/启动结果。
          setConsoleId(entry.meta.id);
          void load();
        }}
      />

      <ServerConsole
        open={consoleId !== null}
        server={consoleServer}
        onClose={() => setConsoleId(null)}
      />

      <ServerSettingsModal
        open={settingsId !== null}
        entry={settingsServer}
        onClose={() => setSettingsId(null)}
        onSaved={(entry) => {
          replaceEntry(entry);
          setSettingsId(null);
        }}
        onDelete={(entry) => setDeleteTarget(entry)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("pages.server.deleteTitle")}
        message={deleteTarget ? t("pages.server.deleteMessage", { name: deleteTarget.meta.name }) : ""}
        confirmText={t("pages.server.delete")}
        danger
        busy={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
