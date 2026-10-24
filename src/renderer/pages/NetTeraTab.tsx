import { useCallback, useEffect, useState } from "react";
import type { TeraStatus } from "../../shared/ipc";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { Field, Segmented, TextInput } from "../components/Form";
import { Modal } from "../components/Modal";
import { OfflineLanNotice } from "../components/OfflineLanNotice";
import { IconAlert, IconInfo, IconLink, IconRefresh } from "../components/icons";

/** 主进程内部 500ms 轮询 /state，这里 700ms 读一次合并后的快照。 */
const POLL_MS = 700;
const PROJECT_URL = "https://github.com/burningtnt/Terracotta";
/** 专用服务器默认端口（与主进程的 DEFAULT_SERVER_PORT 保持一致）。 */
const DEFAULT_SERVER_PORT = 25565;

type HostMode = "lan" | "server";

/**
 * AGPL-3.0 例外条款要求「在用户界面明显处标识本作品的版权信息」：
 * 这段文案是合规声明，固定中文原文，不随界面语言变化。
 */
const CREDIT = "联机能力由 Terracotta | 陶瓦联机 提供 · 版权所有 © burningtnt 及贡献者 · AGPL-3.0-or-later · 项目主页";

const EMPTY: TeraStatus = {
  running: false,
  binaryReady: false,
  secondary: false,
  state: "waiting",
  index: -1,
  players: [],
};

/** 状态机 → i18n 键尾。 */
const STATE_SUFFIX: Record<string, string> = {
  waiting: "stateWaiting",
  "host-scanning": "stateHostScanning",
  "host-starting": "stateHostStarting",
  "host-ok": "stateHostOk",
  "guest-connecting": "stateGuestConnecting",
  "guest-starting": "stateGuestStarting",
  "guest-ok": "stateGuestOk",
  exception: "stateException",
};

/** 陶瓦的 exception 类型 0-5。 */
const EXCEPTION_SUFFIX = ["exc0", "exc1", "exc2", "exc3", "exc4", "exc5"];

/** 成员 kind → i18n 键尾（陶瓦原样返回 HOST/LOCAL/GUEST）。 */
function kindSuffix(kind: string): string {
  if (kind === "HOST") return "kindHost";
  if (kind === "LOCAL") return "kindLocal";
  if (kind === "GUEST") return "kindGuest";
  return "kindUnknown";
}

/** 输入框实时补 U/ 与短横线：只按 16 位本体分组，逐字输入不跳。 */
function formatRoomInput(raw: string): string {
  let body = raw.toUpperCase();
  const slash = body.indexOf("/");
  if (slash >= 0) body = body.slice(slash + 1);
  body = body.replace(/[^0-9A-Z]/g, "");
  // 34 进制本体可能以 U 开头，只在"多出一个 U"时才当前缀去掉
  if (body.length === 17 && body.startsWith("U")) body = body.slice(1);
  body = body.slice(0, 16);
  if (!body) return "";
  const groups = body.match(/.{1,4}/g) ?? [];
  return "U/" + groups.join("-");
}

/**
 * 陶瓦联机（Terracotta）：房主「创建房间」后在游戏里对局域网开放，朋友输邀请码加入。
 * 所有 HTTP 交互都在主进程（本地 API 无 CORS），这里只读状态快照。
 */
export function NetTeraTab() {
  const tr = useT();
  const { push } = useToast();

  const [status, setStatus] = useState<TeraStatus>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [player, setPlayer] = useState("");
  const [hostMode, setHostMode] = useState<HostMode>("lan");
  const [serverPort, setServerPort] = useState(String(DEFAULT_SERVER_PORT));
  const [roomInput, setRoomInput] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState("");
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      api.tera
        .status()
        .then((next) => {
          if (alive) setStatus(next);
        })
        .catch(() => {
          // 轮询失败保留上一份快照，下一次再试
        });
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const run = useCallback(
    async (work: () => Promise<TeraStatus>, okText?: string): Promise<void> => {
      setBusy(true);
      try {
        setStatus(await work());
        if (okText) push(okText, "success");
      } catch (err: unknown) {
        push(errorMessage(err), "error");
      } finally {
        setBusy(false);
      }
    },
    [push],
  );

  /** 优先走主进程剪贴板（file:// 下渲染进程没有 navigator.clipboard 权限），失败再退回浏览器实现。 */
  const copy = async (text: string): Promise<void> => {
    let ok = false;
    try {
      await api.app.copyText(text);
      ok = true;
    } catch {
      ok = await copyText(text);
    }
    push(ok ? tr("pages.netTera.copied", { target: text }) : tr("pages.netTera.copyFailed"), ok ? "success" : "error");
  };

  const openProject = async (): Promise<void> => {
    try {
      await api.app.openExternal(PROJECT_URL);
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    }
  };

  const openLog = async (): Promise<void> => {
    setLogOpen(true);
    setLogLoading(true);
    try {
      setLogText(await api.tera.log());
    } catch (err: unknown) {
      setLogText(errorMessage(err));
    } finally {
      setLogLoading(false);
    }
  };

  const state = status.state;
  const isException = state === "exception";
  const portNumber = Number(serverPort);
  const portOk = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  // 跑起来之后按主进程回报的实际分享方式显示，否则跟随用户当前选择
  const shareMode: HostMode = status.running && status.mode ? status.mode : hostMode;
  const sharePort = status.running && status.serverPort ? status.serverPort : portOk ? portNumber : DEFAULT_SERVER_PORT;
  const host = (): void => {
    const options = hostMode === "server" ? { mode: "server" as const, serverPort: portNumber } : { mode: "lan" as const };
    void run(
      () => api.tera.host(player.trim() || undefined, options),
      tr(hostMode === "server" ? "pages.netTera.hostStartedServer" : "pages.netTera.hostStarted"),
    );
  };
  const exceptionKey = status.exceptionType !== undefined && status.exceptionType >= 0 ? EXCEPTION_SUFFIX[status.exceptionType] : undefined;
  const stateText = tr("pages.netTera." + (STATE_SUFFIX[state] ?? "stateWaiting"));
  // 房客判定：secondary 表示自己不是房主，guest-* 状态说明正在加入别人的房间。
  const isGuest = status.secondary || state.startsWith("guest");

  return (
    <div className="net-tera" data-tera-tab data-tera-mode={shareMode} data-tera-server-port={String(sharePort)}>
      <OfflineLanNotice side={isGuest ? "guest" : "host"} />

      <p className="net-tera-notice" data-tera-notice>
        <IconInfo size={16} />
        <span>{tr("pages.netTera.notice")}</span>
      </p>

      <div className="panel" data-tera-card="status">
        <div className="panel-head">
          <h2 className="panel-title">{tr("pages.netTera.statusTitle")}</h2>
          <span className={"badge net-tera-state " + (status.running ? "is-on" : "is-off")} data-tera-running={status.running ? "true" : "false"}>
            {status.running ? tr("pages.netTera.running") : tr("pages.netTera.idle")}
          </span>
          <div className="net-tera-head-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openLog()} data-tera-log-open>
              {tr("pages.netTera.viewLog")}
            </button>
            {status.running ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void run(() => api.tera.stop(), tr("pages.netTera.stopped"))}
                disabled={busy}
                data-tera-stop
              >
                {status.secondary ? tr("pages.netTera.detach") : tr("pages.netTera.stop")}
              </button>
            ) : null}
          </div>
        </div>

        <p className="net-tera-state-line" data-tera-state={state}>
          <span className="net-tera-state-text">{stateText}</span>
          {status.difficulty ? (
            <span className="net-tera-difficulty">
              {tr("pages.netTera.difficulty")}
              <strong>{status.difficulty}</strong>
            </span>
          ) : null}
        </p>

        {!status.binaryReady && !status.running ? (
          <p className="net-tera-hint" data-tera-first-use>
            {tr("pages.netTera.firstUse")}
          </p>
        ) : null}

        {status.secondary ? (
          <p className="net-tera-warn" data-tera-secondary>
            {tr("pages.netTera.secondary")}
          </p>
        ) : null}

        {status.problem ? (
          <p className="net-tera-error" role="alert" data-tera-problem>
            <IconAlert size={15} />
            {status.problem}
          </p>
        ) : null}

        {status.broadcastError ? (
          <p className="net-tera-warn" role="alert" data-tera-broadcast-error>
            {status.broadcastError}
          </p>
        ) : null}

        {isException ? (
          <div className="net-tera-exception" role="alert" data-tera-exception={status.exceptionType ?? -1}>
            <IconAlert size={16} />
            <span>
              <strong>{tr("pages.netTera.exceptionTitle")}</strong>
              {exceptionKey ? tr("pages.netTera." + exceptionKey) : tr("pages.netTera.excUnknown", { type: String(status.exceptionType ?? -1) })}
            </span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void run(() => api.tera.reset(), tr("pages.netTera.resetDone"))}
              disabled={busy}
              data-tera-back
            >
              <IconRefresh size={14} />
              {tr("pages.netTera.back")}
            </button>
          </div>
        ) : null}
      </div>

      {status.state === "waiting" ? (
        <div className="net-tera-forms">
          <div className="panel" data-tera-card="host">
            <div className="panel-head">
              <h2 className="panel-title">{tr("pages.netTera.hostTitle")}</h2>
            </div>
            <Field label={tr("pages.netTera.modeLabel")}>
              <div data-tera-mode={hostMode}>
                <Segmented
                  value={hostMode}
                  options={[
                    { value: "lan", label: tr("pages.netTera.modeLan") },
                    { value: "server", label: tr("pages.netTera.modeServer") },
                  ]}
                  onChange={setHostMode}
                />
              </div>
            </Field>
            {hostMode === "server" ? (
              <Field
                label={tr("pages.netTera.serverPortLabel")}
                hint={portOk ? tr("pages.netTera.serverPortHint") : tr("pages.netTera.serverPortBad")}
              >
                <TextInput
                  value={serverPort}
                  aria-label={tr("pages.netTera.serverPortLabel")}
                  inputMode="numeric"
                  spellCheck={false}
                  maxLength={5}
                  className="net-tera-input net-tera-port"
                  data-tera-port-input
                  onChange={(event) => setServerPort(event.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
                />
              </Field>
            ) : null}
            <Field label={tr("pages.netTera.playerLabel")} hint={tr("pages.netTera.playerHint")}>
              <TextInput
                value={player}
                aria-label={tr("pages.netTera.playerLabel")}
                placeholder={tr("pages.netTera.playerPlaceholder")}
                spellCheck={false}
                maxLength={16}
                data-tera-player
                onChange={(event) => setPlayer(event.target.value)}
              />
            </Field>
            <p className="net-note">
              {hostMode === "server" ? tr("pages.netTera.modeServerHint") : tr("pages.netTera.hostHint")}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={host}
              disabled={busy || (hostMode === "server" && !portOk)}
              data-tera-host
              data-action="tera-host"
            >
              {busy ? tr("pages.netTera.starting") : tr("pages.netTera.hostAction")}
            </button>
          </div>

          <div className="panel" data-tera-card="join">
            <div className="panel-head">
              <h2 className="panel-title">{tr("pages.netTera.joinTitle")}</h2>
            </div>
            <Field label={tr("pages.netTera.roomLabel")} hint={tr("pages.netTera.roomHint")}>
              <TextInput
                value={roomInput}
                aria-label={tr("pages.netTera.roomLabel")}
                placeholder="U/XXXX-XXXX-XXXX-XXXX"
                spellCheck={false}
                maxLength={21}
                data-tera-room-input
                className="net-tera-input"
                onChange={(event) => setRoomInput(formatRoomInput(event.target.value))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && roomInput) void run(() => api.tera.join(roomInput, player.trim() || undefined), tr("pages.netTera.joinStarted"));
                }}
              />
            </Field>
            <p className="net-note">{tr("pages.netTera.joinHint")}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void run(() => api.tera.join(roomInput, player.trim() || undefined), tr("pages.netTera.joinStarted"))}
              disabled={busy || roomInput.length < 21}
              data-tera-join
            >
              {busy ? tr("pages.netTera.starting") : tr("pages.netTera.joinAction")}
            </button>
          </div>
        </div>
      ) : null}

      {status.room && (state === "host-ok" || state === "host-starting") ? (
        <div className="panel" data-tera-card="room">
          <div className="panel-head">
            <h2 className="panel-title">{tr("pages.netTera.inviteTitle")}</h2>
          </div>
          <div className="net-tera-code-row">
            <code className="net-tera-code" data-tera-room>
              {status.room}
            </code>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(status.room ?? "")} data-tera-copy-room>
              {tr("pages.netTera.copy")}
            </button>
          </div>
          <p className="net-note">{tr("pages.netTera.inviteHint")}</p>
          {status.mode === "server" && status.serverPort ? (
            <p className="net-tera-share" data-tera-shared>
              {tr("pages.netTera.sharedLocal", { address: "127.0.0.1:" + status.serverPort })}
            </p>
          ) : null}
        </div>
      ) : null}

      {status.url ? (
        <div className="panel" data-tera-card="url">
          <div className="panel-head">
            <h2 className="panel-title">{tr("pages.netTera.addressTitle")}</h2>
          </div>
          <div className="net-tera-code-row">
            <code className="net-tera-code" data-tera-url>
              {status.url}
            </code>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(status.url ?? "")} data-tera-copy-url>
              {tr("pages.netTera.copy")}
            </button>
          </div>
          <p className="net-note">{tr("pages.netTera.addressHint")}</p>
        </div>
      ) : null}

      <div className="panel" data-tera-card="members">
        <div className="panel-head">
          <h2 className="panel-title">{tr("pages.netTera.membersTitle")}</h2>
          <span className="panel-count" data-tera-member-count>
            {status.players.length}
          </span>
        </div>
        {status.players.length === 0 ? (
          <p className="net-note" data-tera-members-empty>
            {tr("pages.netTera.membersEmpty")}
          </p>
        ) : (
          <ul className="net-tera-members" data-tera-members>
            {status.players.map((item) => (
              <li className="net-tera-member" key={item.machineId || item.name} data-tera-member={item.name}>
                <span className="net-tera-member-name">{item.name}</span>
                <span className="badge net-tera-kind">{tr("pages.netTera." + kindSuffix(item.kind))}</span>
                {item.vendor ? <span className="net-tera-member-vendor">{item.vendor}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="net-tera-credit" data-tera-credit>
        <span>
          {CREDIT}
          {" "}
          <button type="button" className="net-tera-credit-link" onClick={() => void openProject()} data-tera-credit-link>
            <IconLink size={12} />
            github.com/burningtnt/Terracotta
          </button>
        </span>
      </footer>

      <Modal
        open={logOpen}
        title={tr("pages.netTera.logTitle")}
        subtitle={tr("pages.netTera.logSubtitle")}
        onClose={() => setLogOpen(false)}
        width={720}
        footer={
          <button type="button" className="btn btn-ghost" onClick={() => setLogOpen(false)}>
            {tr("pages.common.close")}
          </button>
        }
      >
        {logLoading ? (
          <p className="net-note">{tr("pages.netTera.logLoading")}</p>
        ) : (
          <pre className="net-tera-log" data-tera-log>
            {logText || tr("pages.netTera.logEmpty")}
          </pre>
        )}
      </Modal>
    </div>
  );
}
