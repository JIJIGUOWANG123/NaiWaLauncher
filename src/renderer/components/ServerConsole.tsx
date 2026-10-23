import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ServerConsoleLine, ServerEntry, ServerStatus } from "../../shared/types";
import { api } from "../lib/api";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "./Toast";
import { Drawer } from "./Drawer";
import { IconPause, IconTrash } from "./icons";

const STATUS_LABEL: Record<ServerStatus, string> = {
  stopped: "已停止",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  crashed: "已崩溃",
};

/** 控制台一次最多保留多少行：再多也只是滚屏，界面没必要背着。 */
const MAX_LINES = 800;

function clock(at: number): string {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

/**
 * 服务端控制台：先拉一次缓冲，再订阅增量与状态。
 * 自动滚到底，但用户往上翻时不再强拉（判定 scrollHeight - scrollTop - clientHeight 的距离）。
 */
export function ServerConsole({
  open, server, onClose,
}: {
  open: boolean;
  server: ServerEntry | null;
  onClose: () => void;
}) {
  const { push } = useToast();
  const serverId = server?.meta.id ?? null;
  const [lines, setLines] = useState<ServerConsoleLine[]>([]);
  const [status, setStatus] = useState<ServerStatus>("stopped");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [follow, setFollow] = useState(true);
  // 上箭头回看历史命令：history 存发过的，historyIndex 是当前翻到第几条（null = 不在回看）。
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open || !serverId) return;
    setStatus(server?.status ?? "stopped");
  }, [open, server?.status, serverId]);

  // 打开时拉缓冲 + 订阅：增量行按 serverId 过滤，状态变化同步到标签。
  useEffect(() => {
    if (!open || !serverId) return;
    let alive = true;
    setLoading(true);
    setLines([]);
    setError(null);
    setFollow(true);
    void api.servers.console(serverId, 500)
      .then((buffer) => {
        if (!alive) return;
        setLines(buffer.slice(-MAX_LINES));
      })
      .catch((err: unknown) => {
        if (alive) setError(errorMessage(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    const offLine = api.servers.onConsole((line) => {
      if (!alive || line.serverId !== serverId) return;
      setLines((prev) => [...prev, line].slice(-MAX_LINES));
    });
    const offStatus = api.servers.onStatus((entries) => {
      if (!alive) return;
      const found = entries.find((item) => item.meta.id === serverId);
      if (found) setStatus(found.status);
    });
    return () => {
      alive = false;
      offLine();
      offStatus();
    };
  }, [open, serverId]);

  // 只在「贴着底部」时自动跟随；用户往上翻就不打断他。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !follow) return;
    element.scrollTop = element.scrollHeight;
  }, [follow, lines]);

  const send = async () => {
    const line = draft.trim();
    if (!serverId || !line) return;
    setSending(true);
    try {
      await api.servers.command(serverId, line);
      setHistory((prev) => [...prev, line].slice(-50));
      setHistoryIndex(null);
      setDraft("");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const stop = async () => {
    if (!serverId) return;
    setStopping(true);
    try {
      await api.servers.stop(serverId);
      push("已发送停止指令，等待世界保存完成", "info");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setStopping(false);
    }
  };

  /** 输入框键盘：回车发送，上下箭头翻历史命令。 */
  const onInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void send();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (history.length === 0) return;
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setDraft(history[next] ?? "");
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(null);
        setDraft("");
        return;
      }
      setHistoryIndex(next);
      setDraft(history[next] ?? "");
    }
  }, [history, historyIndex, send]);

  const canInput = status === "running" || status === "starting";

  return (
    <Drawer
      open={open && server !== null}
      title={server?.meta.name ?? "控制台"}
      subtitle={server ? `${server.meta.core} ${server.meta.coreVersion} · Minecraft ${server.meta.mcVersion} · 端口 ${server.meta.port}` : undefined}
      width={820}
      onClose={onClose}
      footer={(
        <div className="console-input-row">
          <span className="console-prompt" aria-hidden="true">&gt;</span>
          <input
            ref={inputRef}
            className="console-input"
            data-console-input
            value={draft}
            placeholder={canInput ? "输入命令，回车发送（↑ 回看历史）" : "服务端没在运行，先点「启动」"}
            aria-label="服务端命令"
            disabled={!canInput || sending}
            onChange={(event) => {
              setDraft(event.target.value);
              setHistoryIndex(null);
            }}
            onKeyDown={onInputKeyDown}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-action="server-command-send"
            onClick={() => void send()}
            disabled={!canInput || sending || draft.trim() === ""}
          >
            发送
          </button>
        </div>
      )}
    >
      <div className="console-toolbar">
        <span className="server-status" data-server-status={status}>{STATUS_LABEL[status]}</span>
        <span className="console-hint">
          {status === "running" ? "已连接：日志实时推送" : status === "crashed" ? "进程已崩溃，看下方的 stderr" : "未运行"}
        </span>
        <div className="console-toolbar-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-action="server-stop"
            onClick={() => void stop()}
            disabled={stopping || (status !== "running" && status !== "starting")}
          >
            <IconPause size={14} />
            {stopping ? "停止中…" : "停止"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-action="server-console-clear"
            onClick={() => setLines([])}
            title="只清界面上的日志，不影响服务端"
          >
            <IconTrash size={14} />
            清屏
          </button>
        </div>
      </div>

      {error ? <p className="server-form-error">{error}</p> : null}
      {loading ? <p className="console-hint">正在读取日志…</p> : null}

      <div
        className="console-log"
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          setFollow(atBottom);
        }}
      >
        {lines.length === 0 && !loading ? (
          <p className="console-empty">还没有日志：启动服务端后，控制台输出会出现在这里。</p>
        ) : null}
        {lines.map((line, index) => (
          <div
            key={`${line.at}-${index}`}
            className={`console-line is-${line.stream}`}
            data-console-line={line.stream}
          >
            <span className="console-time">{clock(line.at)}</span>
            <span className="console-text">{line.text}</span>
          </div>
        ))}
      </div>
    </Drawer>
  );
}
