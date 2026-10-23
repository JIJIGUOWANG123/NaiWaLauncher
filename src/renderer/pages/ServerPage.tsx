import { useCallback, useEffect, useState } from "react";
import type { ServerCoreId, ServerEntry, ServerStatus } from "../../shared/types";
import { api } from "../lib/api";
import { formatRelative } from "../lib/format";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { ConfirmDialog, Modal } from "../components/Modal";
import { Field, Slider, TextInput, Toggle } from "../components/Form";
import { EmptyState, ErrorState, SkeletonCards } from "../components/State";
import { ServerConsole } from "../components/ServerConsole";
import { ServerCreateModal } from "../components/ServerCreateModal";
import { IconList, IconPause, IconPlay, IconPlus, IconRefresh, IconSettings } from "../components/icons";

const STATUS_LABEL: Record<ServerStatus, string> = {
  stopped: "已停止",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  crashed: "已崩溃",
};

/** 卡片上的中文分类：与 cores() 的 tag 同义，只是 ServerEntry 里没有 tag 字段，按核心名映射。 */
const CORE_TAG: Record<ServerCoreId, string> = {
  Vanilla: "原版",
  Paper: "插件服",
  Purpur: "插件服",
  Folia: "插件服",
  Fabric: "模组服",
  Forge: "模组服",
  NeoForge: "模组服",
  Arclight: "模组服",
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
      setError("名称不能为空");
      return;
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError("端口需要是 1-65535 的整数");
      return;
    }
    if (!Number.isInteger(maxNum) || maxNum < 1 || maxNum > 1000) {
      setError("最大人数需要是 1-1000 的整数");
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
      push("设置已保存", "success");
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
      title="服务端设置"
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
            删除
          </button>
          <span className="modal-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="btn btn-primary" data-action="server-save" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </>
      )}
    >
      <div className="form-grid">
      <Field label="名称">
        <TextInput value={name} maxLength={40} aria-label="服务端名称" onChange={(event) => setName(event.target.value)} disabled={saving} />
      </Field>
      <div className="server-form-row">
        <Field label="端口" hint="改完要重启服务端才生效">
          <TextInput
            type="number"
            min={1}
            max={65535}
            value={port}
            aria-label="端口"
            onChange={(event) => setPort(event.target.value)}
            disabled={saving}
          />
        </Field>
        <Field label="最大人数">
          <TextInput
            type="number"
            min={1}
            max={1000}
            value={maxPlayers}
            aria-label="最大人数"
            onChange={(event) => setMaxPlayers(event.target.value)}
            disabled={saving}
          />
        </Field>
      </div>
      <Field label="内存" hint="写进启动参数 -Xmx">
        <Slider value={memoryMb} min={512} max={16384} step={512} onChange={setMemoryMb} format={(value) => `${value} MB`} disabled={saving} />
      </Field>
      <Toggle checked={onlineMode} onChange={setOnlineMode} label="正版验证" hint="关掉后离线客户端也能进（online-mode=false）" />
      <p className="server-form-note">删除会连同 servers 下这个目录一起移除，存档也在里面。</p>
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
      push(`正在启动「${entry.meta.name}」`, "success");
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
      push(`正在停止「${entry.meta.name}」`, "info");
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
      push(`已删除服务端「${deleteTarget.meta.name}」`, "success");
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
          <h1 className="page-title">开服</h1>
          <p className="page-sub">每个服务端单独管理：核心与构建来自 FastMirror，数据放在启动器目录的 servers 下。</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void load()} disabled={loading}>
            <IconRefresh size={16} />
            刷新
          </button>
          <button type="button" className="btn btn-primary" data-action="server-create" onClick={() => setCreateOpen(true)}>
            <IconPlus size={16} />
            新建服务端
          </button>
        </div>
      </header>

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {!error && loading && servers === null ? <SkeletonCards count={3} /> : null}

      {!error && servers !== null && servers.length === 0 ? (
        <EmptyState
          title="还没有服务端，新建一个"
          hint="服务端从 FastMirror 下载，数据存在启动器目录的 servers 下；每个服务端有独立的端口、内存与控制台。"
          action={(
            <button type="button" className="btn btn-primary" data-action="server-create" onClick={() => setCreateOpen(true)}>
              <IconPlus size={16} />
              新建服务端
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
                        {STATUS_LABEL[entry.status]}
                      </span>
                      <span className="server-card-meta-item">Minecraft {meta.mcVersion}</span>
                      <span className="server-card-meta-item">{CORE_TAG[meta.core]}</span>
                    </p>
                  </div>
                </div>

                <dl className="server-facts">
                  <div>
                    <dt>构建</dt>
                    <dd title={meta.coreVersion}>{meta.coreVersion}</dd>
                  </div>
                  <div>
                    <dt>端口</dt>
                    <dd>{meta.port}</dd>
                  </div>
                  <div>
                    <dt>内存</dt>
                    <dd>{meta.memoryMb} MB</dd>
                  </div>
                  <div>
                    <dt>最后启动</dt>
                    <dd>{meta.lastStartedAt ? formatRelative(meta.lastStartedAt) : "从未启动"}</dd>
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
                    {busy && stopped ? "启动中…" : "启动"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-action="server-stop"
                    onClick={() => void stop(entry)}
                    disabled={busy || !running}
                  >
                    <IconPause size={15} />
                    {busy && running ? "停止中…" : "停止"}
                  </button>
                  <button type="button" className="btn btn-ghost" data-action="server-console" onClick={() => setConsoleId(meta.id)}>
                    <IconList size={15} />
                    控制台
                  </button>
                  <button type="button" className="btn btn-ghost" data-action="server-settings" onClick={() => setSettingsId(meta.id)}>
                    <IconSettings size={15} />
                    设置
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
        title="删除服务端"
        message={deleteTarget
          ? `确定删除「${deleteTarget.meta.name}」吗？servers 下这个目录（含存档、插件与配置）会一起删除。`
          : ""}
        confirmText="删除"
        danger
        busy={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
