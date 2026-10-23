import { useCallback, useEffect, useRef, useState } from "react";
import type { NatfrpStatus, NatfrpTunnel, NatfrpUser } from "../../shared/types";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { formatBytes } from "../lib/format";
import { useT } from "../lib/i18n";
import { usePersist } from "../lib/persist";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorState, SkeletonRows } from "../components/State";
import { Field, Select, TextInput } from "../components/Form";
import { Modal } from "../components/Modal";
import {
  IconAlert, IconCheck, IconEye, IconEyeOff, IconInfo, IconLink, IconPlus, IconRefresh,
} from "../components/icons";

const DEFAULT_LOCAL_PORT = 25565;
/** 公网地址来自 frpc 输出，启动后每 2 秒问一次状态。 */
const STATUS_POLL_MS = 2000;
const NATFRP_HOME = "https://www.natfrp.com/";

/** 端口输入框：只允许 1-65535，越界按默认值兜底。 */
function readPort(raw: string, fallback = DEFAULT_LOCAL_PORT): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > 65535) return fallback;
  return value;
}

/** 新建隧道的默认名：NaiWa-<月日>-<时分>。 */
function defaultTunnelName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `NaiWa-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * 樱花穿透（内置）：访问密钥 → 账号卡（流量 + 签到状态，只读）→ 隧道列表 → 新建隧道。
 * 签到只在 natfrp.com 网页完成，启动器不代签；未保存访问密钥时整页退回引导态。
 */
export function NetFrpTab() {
  const { settings } = useApp();
  const persist = usePersist();
  const { push } = useToast();
  const tr = useT();

  const savedToken = (settings?.natfrpToken ?? "").trim();

  const [tokenDraft, setTokenDraft] = useState(settings?.natfrpToken ?? "");
  const [showToken, setShowToken] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const tokenRowRef = useRef<HTMLDivElement | null>(null);

  // 设置被别处改动（保存后回读、清空）时同步草稿。
  useEffect(() => setTokenDraft(settings?.natfrpToken ?? ""), [settings?.natfrpToken]);

  const [user, setUser] = useState<NatfrpUser | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const tunnelList = useAsync<NatfrpTunnel[]>(
    () => (savedToken ? api.net.natfrpTunnels() : Promise.resolve([])),
    [savedToken],
  );
  const nodeList = useAsync(
    () => (savedToken ? api.net.natfrpNodes() : Promise.resolve([])),
    [savedToken],
  );
  const tunnels = tunnelList.data ?? [];
  const nodes = nodeList.data ?? [];

  const [status, setStatus] = useState<NatfrpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const runningId = status?.running ? status.tunnelId ?? null : null;

  // 运行状态：启动后 2 秒轮询一次；停止后不再发起轮询。
  useEffect(() => {
    if (!savedToken) {
      setStatus(null);
      return;
    }
    let alive = true;
    const tick = () => {
      api.net
        .natfrpStatus()
        .then((next) => {
          if (alive) setStatus(next);
        })
        .catch(() => {
          // 轮询失败保留上一次状态，下一次再试；不弹 toast 打扰游戏前操作。
        });
    };
    tick();
    if (!status?.running) return () => { alive = false; };
    const timer = window.setInterval(tick, STATUS_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedToken, status?.running]);

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      await api.app.copyText(text);
      return true;
    } catch {
      return copyText(text);
    }
  };

  const copy = async (text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) push(tr("pages.netLan.copied", { target: text }), "success");
    else push(tr("pages.netLan.copyFailed"), "error");
  };

  const focusTokenInput = () => {
    const row = tokenRowRef.current;
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
    row?.querySelector("input")?.focus();
  };

  const saveToken = async (): Promise<boolean> => {
    const next = tokenDraft.trim();
    setSavingToken(true);
    const ok = await persist({ natfrpToken: next }, tr("pages.netFrp.persistToken"));
    setSavingToken(false);
    if (ok && next !== savedToken) {
      // 换了 key，之前验证出来的账号信息就作废了。
      setUser(null);
      setVerifyError(null);
      setStatus(null);
    }
    return ok;
  };

  const verify = async () => {
    const next = tokenDraft.trim();
    if (!next) {
      setVerifyError(tr("pages.netFrp.errTokenRequired"));
      push(tr("pages.netFrp.errTokenRequiredVerify"), "error");
      focusTokenInput();
      return;
    }
    setVerifying(true);
    setVerifyError(null);
    try {
      if (next !== savedToken) {
        const saved = await persist({ natfrpToken: next }, tr("pages.netFrp.persistToken"));
        if (!saved) throw new Error(tr("pages.netFrp.errTokenSaveFailed"));
      }
      const info = await api.net.natfrpUser();
      setUser(info);
      push(tr("pages.netFrp.verifyOk", { name: info.name }), "success");
      tunnelList.reload();
      nodeList.reload();
    } catch (error: unknown) {
      const message = errorMessage(error);
      setUser(null);
      setVerifyError(message);
      push(tr("pages.netFrp.verifyFailed", { error: message }), "error");
    } finally {
      setVerifying(false);
    }
  };

  /** 签到只在网页完成，这里只负责把用户送到 natfrp.com。 */
  const openSite = async () => {
    try {
      await api.app.openExternal(NATFRP_HOME);
      push(tr("pages.netFrp.openedSite"), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const startTunnel = async (tunnel: NatfrpTunnel) => {
    setBusy(true);
    try {
      const next = await api.net.natfrpStart(tunnel.id);
      setStatus(next);
      tunnelList.reload();
      push(
        next.address
          ? tr("pages.netFrp.startedWithAddr", { name: tunnel.name, address: next.address })
          : tr("pages.netFrp.startedWaiting", { name: tunnel.name }),
        "success",
      );
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const stopTunnel = async () => {
    setBusy(true);
    try {
      const next = await api.net.natfrpStop();
      setStatus(next);
      tunnelList.reload();
      push(tr("pages.netFrp.stopped"), "info");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState(defaultTunnelName);
  const [createPort, setCreatePort] = useState(String(DEFAULT_LOCAL_PORT));
  const [createNode, setCreateNode] = useState("");
  const [creating, setCreating] = useState(false);

  const nodeOptions = nodes.map((node) => ({
    value: String(node.id),
    label: tr(node.publicGameAllowed ? "pages.netFrp.nodeOk" : "pages.netFrp.nodeBad", { name: node.name }),
  }));
  const selectedNode = nodes.find((node) => String(node.id) === createNode) ?? null;

  const openCreate = useCallback(() => {
    setCreateName(defaultTunnelName());
    setCreatePort(String(DEFAULT_LOCAL_PORT));
    const preferred = nodes.find((node) => node.publicGameAllowed) ?? nodes[0];
    setCreateNode(preferred ? String(preferred.id) : "");
    setCreateOpen(true);
  }, [nodes]);

  const submitCreate = async () => {
    const name = createName.trim();
    if (!name) {
push(tr("pages.netFrp.errNameRequired"), "error");
      return;
    }
    if (!createNode) {
push(tr("pages.netFrp.errNodeRequired"), "error");
      return;
    }
    setCreating(true);
    try {
      const created = await api.net.natfrpCreate(name, Number(createNode), readPort(createPort));
      setCreateOpen(false);
      tunnelList.reload();
      push(tr("pages.netFrp.created", { name: created.name }), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="net-frp" data-frp-tab>
      <p className="net-frp-notice" data-frp-notice>
        <IconInfo size={16} />
        <span>
          {tr("pages.netFrp.noticeBefore")}
          <strong>{tr("pages.netFrp.noticeStrong")}</strong>
          {tr("pages.netFrp.noticeAfter")}
        </span>
      </p>

      <div className="panel" data-frp-card="account">
        <div className="panel-head">
          <h2 className="panel-title">{tr("pages.netFrp.accountTitle")}</h2>
          <span className="panel-count">
            {user
              ? tr("pages.netFrp.statusVerified")
              : savedToken
                ? tr("pages.netFrp.statusSaved")
                : tr("pages.netFrp.statusEmpty")}
          </span>
        </div>

        <Field label={tr("pages.netFrp.tokenLabel")} hint={tr("pages.netFrp.tokenHint")}>
          <div className="key-row" ref={tokenRowRef} data-frp-token-row>
            <TextInput
              type={showToken ? "text" : "password"}
              value={tokenDraft}
              aria-label={tr("pages.netFrp.tokenAria")}
              placeholder={tr("pages.netFrp.tokenPlaceholder")}
              data-frp-token-input
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setTokenDraft(event.target.value);
                setVerifyError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void verify();
              }}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setShowToken((value) => !value)}
              aria-label={showToken ? tr("pages.netFrp.hideToken") : tr("pages.netFrp.showToken")}
              data-frp-token-toggle
            >
              {showToken ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void saveToken()} disabled={savingToken} data-frp-token-save>
              {savingToken ? tr("pages.common.saving") : tr("pages.common.save")}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void verify()} disabled={verifying} data-frp-verify>
              {verifying ? tr("pages.netFrp.verifying") : tr("pages.netFrp.verify")}
            </button>
          </div>
        </Field>

        {verifyError ? (
          <p className="net-result bad" role="alert" data-frp-verify-result="fail">
            <IconAlert size={15} />
            {tr("pages.netFrp.verifyFailed", { error: verifyError ?? "" })}
          </p>
        ) : null}

        {user ? (
          <div className="net-frp-account" data-frp-account>
            <p className="net-result ok" role="status" data-frp-verify-result="ok">
              <IconCheck size={15} />
              {tr("pages.netFrp.loggedInAs", { name: user.name })}
            </p>

            <div className="net-frp-figures">
              <span className="net-frp-figure" data-frp-traffic-left>
                {tr("pages.netFrp.trafficLeft")}
                <strong>{formatBytes(user.trafficLeft ?? 0)}</strong>
              </span>
              <span className="net-frp-figure" data-frp-traffic-today>
                {tr("pages.netFrp.trafficToday")}
                <strong>{formatBytes(user.trafficToday ?? 0)}</strong>
              </span>
              {user.groupName ? (
                <span className="net-frp-figure">
                  {tr("pages.netFrp.group")}
                  <strong>{user.groupName}</strong>
                </span>
              ) : null}
            </div>

            <div className="net-frp-sign" data-frp-sign>
              <span
                className={`badge ${user.signed ? "net-frp-signed" : "muted-tag"}`}
                data-frp-signed={user.signed ? "true" : "false"}
              >
                {user.signed ? <IconCheck size={12} /> : null}
                {user.signed
                  ? user.signDays !== undefined
                    ? tr("pages.netFrp.signedStreak", { days: user.signDays })
                    : tr("pages.netFrp.signedToday")
                  : tr("pages.netFrp.notSigned")}
              </span>
              <span className="net-frp-sign-note" data-frp-sign-hint>{tr("pages.netFrp.signHint")}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openSite()} data-frp-open-site>
                <IconLink size={14} />
                {tr("pages.netFrp.openSite")}
              </button>
            </div>
          </div>
        ) : null}

      </div>

      {savedToken ? (
        <div className="panel" data-frp-card="tunnels">
          <div className="panel-head">
            <h2 className="panel-title">{tr("pages.netFrp.tunnelsTitle")}</h2>
            <span className="panel-count">{tr("pages.netFrp.tunnelCount", { count: tunnels.length })}</span>
            <div className="net-frp-head-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => tunnelList.reload()} disabled={tunnelList.loading} data-frp-tunnels-reload>
                <IconRefresh size={15} />
                {tr("pages.common.refresh")}
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={openCreate} data-frp-create-open>
                <IconPlus size={15} />
                {tr("pages.netFrp.newTunnel")}
              </button>
            </div>
          </div>

          {tunnelList.loading && tunnels.length === 0 ? <SkeletonRows count={2} /> : null}
          {tunnelList.error ? <ErrorState message={tunnelList.error} onRetry={tunnelList.reload} /> : null}
          {!tunnelList.loading && !tunnelList.error && tunnels.length === 0 ? (
            <EmptyState title={tr("pages.netFrp.tunnelsEmptyTitle")} hint={tr("pages.netFrp.tunnelsEmptyHint")} />
          ) : null}

          {tunnels.length > 0 ? (
            <ul className="net-frp-list">
              {tunnels.map((tunnel) => {
                const isRunning = runningId === tunnel.id;
                const address = isRunning ? status?.address ?? "" : "";
                return (
                  <li className="net-frp-row" key={tunnel.id} data-frp-tunnel={tunnel.id}>
                    <div className="net-frp-row-main">
                      <span className="net-frp-row-name">{tunnel.name}</span>
                      <span
                        className={`badge net-frp-state ${tunnel.online ? "is-online" : "is-offline"}`}
                        data-frp-online={tunnel.online ? "true" : "false"}
                      >
                        {tunnel.online ? tr("pages.netFrp.online") : tr("pages.netFrp.offline")}
                      </span>
                    </div>
                    <div className="net-frp-row-meta">
                      <span data-frp-node>{tunnel.nodeName ?? tr("pages.netFrp.nodeFallback", { id: tunnel.node })}</span>
                      <span>
                        {tr("pages.netFrp.localPortBefore")}
                        <code className="net-frp-port">{tunnel.localPort}</code>
                      </span>
                    </div>
                    <div className="net-frp-row-actions">
                      {isRunning ? (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void stopTunnel()} disabled={busy} data-frp-stop>
                          {tr("pages.netFrp.stop")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => void startTunnel(tunnel)}
                          disabled={busy}
                          data-frp-start={tunnel.id}
                        >
                          {tr("pages.netFrp.start")}
                        </button>
                      )}
                    </div>
                    {address ? (
                      <div className="net-frp-row-addr" data-frp-address={address}>
                        <span className="net-frp-addr-label">{tr("pages.netFrp.publicAddress")}</span>
                        <code className="net-addr-value">{address}</code>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(address)} data-frp-copy>
                          {tr("pages.netLan.copy")}
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="panel" data-frp-card="guide">
          <EmptyState
            title={tr("pages.netFrp.guideTitle")}
            hint={tr("pages.netFrp.guideHint")}
            action={
              <button type="button" className="btn btn-primary" onClick={focusTokenInput} data-frp-guide-action>
                {tr("pages.netFrp.guideAction")}
              </button>
            }
          />
        </div>
      )}

      <Modal
        open={createOpen}
        title={tr("pages.netFrp.createTitle")}
        subtitle={tr("pages.netFrp.createSubtitle")}
        onClose={() => setCreateOpen(false)}
        width={480}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              {tr("pages.common.cancel")}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void submitCreate()} disabled={creating} data-frp-create-submit>
              {creating ? tr("pages.netFrp.creating") : tr("pages.netFrp.create")}
            </button>
          </>
        }
      >
        <div className="net-frp-form">
          <Field label={tr("pages.netFrp.tunnelName")}>
            <TextInput
              value={createName}
              aria-label={tr("pages.netFrp.tunnelName")}
              data-frp-create-name
              spellCheck={false}
              onChange={(event) => setCreateName(event.target.value)}
            />
          </Field>
          <Field label={tr("pages.netFrp.portLabel")} hint={tr("pages.netFrp.portHint")}>
            <TextInput
              value={createPort}
              inputMode="numeric"
              aria-label={tr("pages.netFrp.portLabel")}
              data-frp-create-port
              onChange={(event) => setCreatePort(event.target.value)}
            />
          </Field>
          <Field label={tr("pages.netFrp.nodeLabel")} hint={tr("pages.netFrp.nodeHint")}>
            <Select
              value={createNode}
              options={nodeOptions}
              onChange={setCreateNode}
              ariaLabel={tr("pages.netFrp.nodeLabel")}
              placeholder={nodeList.loading ? tr("pages.netFrp.nodesLoading") : tr("pages.netFrp.selectNode")}
            />
          </Field>
          {selectedNode && !selectedNode.publicGameAllowed ? (
            <p className="net-frp-warn" data-frp-node-warn>
              {tr("pages.netFrp.nodeWarn", { name: selectedNode.name })}
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
