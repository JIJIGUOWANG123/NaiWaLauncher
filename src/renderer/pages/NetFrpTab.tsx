import { useCallback, useEffect, useRef, useState } from "react";
import type { NatfrpStatus, NatfrpTunnel, NatfrpUser } from "../../shared/types";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { formatBytes } from "../lib/format";
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
    if (ok) push(`已复制 ${text}`, "success");
    else push("复制失败，请手动选中地址复制", "error");
  };

  const focusTokenInput = () => {
    const row = tokenRowRef.current;
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
    row?.querySelector("input")?.focus();
  };

  const saveToken = async (): Promise<boolean> => {
    const next = tokenDraft.trim();
    setSavingToken(true);
    const ok = await persist({ natfrpToken: next }, "访问密钥");
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
      setVerifyError("请先填写访问密钥");
      push("请先填写访问密钥再验证", "error");
      focusTokenInput();
      return;
    }
    setVerifying(true);
    setVerifyError(null);
    try {
      if (next !== savedToken) {
        const saved = await persist({ natfrpToken: next }, "访问密钥");
        if (!saved) throw new Error("访问密钥保存失败，验证已取消");
      }
      const info = await api.net.natfrpUser();
      setUser(info);
      push(`验证成功：已登录 ${info.name}`, "success");
      tunnelList.reload();
      nodeList.reload();
    } catch (error: unknown) {
      const message = errorMessage(error);
      setUser(null);
      setVerifyError(message);
      push(`验证失败：${message}`, "error");
    } finally {
      setVerifying(false);
    }
  };

  /** 签到只在网页完成，这里只负责把用户送到 natfrp.com。 */
  const openSite = async () => {
    try {
      await api.app.openExternal(NATFRP_HOME);
      push("已在浏览器打开 natfrp.com，登录后即可签到", "success");
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
      push(next.address ? `已启动 ${tunnel.name}：${next.address}` : `已启动 ${tunnel.name}，等待分配公网地址…`, "success");
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
      push("已停止穿透", "info");
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
    label: node.publicGameAllowed ? `${node.name}｜满足「公开游戏服务器」` : `${node.name}｜不满足「公开游戏服务器」`,
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
      push("请先填写隧道名", "error");
      return;
    }
    if (!createNode) {
      push("请先选择节点", "error");
      return;
    }
    setCreating(true);
    try {
      const created = await api.net.natfrpCreate(name, Number(createNode), readPort(createPort));
      setCreateOpen(false);
      tunnelList.reload();
      push(`已创建隧道 ${created.name}`, "success");
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
        <span>樱花穿透由 natfrp.com 提供。<strong>公开游戏服务器</strong>只能使用标注「多线」的节点，否则账号可能被封禁；小群熟人联机可用任意节点。</span>
      </p>

      <div className="panel" data-frp-card="account">
        <div className="panel-head">
          <h2 className="panel-title">账号</h2>
          <span className="panel-count">
            {user ? "已验证" : savedToken ? "已保存访问密钥，点「验证」拉取账号" : "先填访问密钥"}
          </span>
        </div>

        <Field label="访问密钥（Access Token）" hint="natfrp.com →「用户信息 → 访问密钥」里复制；只写进本机 config/settings.json。">
          <div className="key-row" ref={tokenRowRef} data-frp-token-row>
            <TextInput
              type={showToken ? "text" : "password"}
              value={tokenDraft}
              aria-label="樱花穿透访问密钥"
              placeholder="粘贴 natfrp.com 的访问密钥"
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
              aria-label={showToken ? "隐藏访问密钥" : "显示访问密钥"}
              data-frp-token-toggle
            >
              {showToken ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void saveToken()} disabled={savingToken} data-frp-token-save>
              {savingToken ? "保存中…" : "保存"}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void verify()} disabled={verifying} data-frp-verify>
              {verifying ? "验证中…" : "验证"}
            </button>
          </div>
        </Field>

        {verifyError ? (
          <p className="net-result bad" role="alert" data-frp-verify-result="fail">
            <IconAlert size={15} />
            验证失败：{verifyError}
          </p>
        ) : null}

        {user ? (
          <div className="net-frp-account" data-frp-account>
            <p className="net-result ok" role="status" data-frp-verify-result="ok">
              <IconCheck size={15} />
              已登录：{user.name}
            </p>

            <div className="net-frp-figures">
              <span className="net-frp-figure" data-frp-traffic-left>
                剩余流量 <strong>{formatBytes(user.trafficLeft ?? 0)}</strong>
              </span>
              <span className="net-frp-figure" data-frp-traffic-today>
                本日已用 <strong>{formatBytes(user.trafficToday ?? 0)}</strong>
              </span>
              {user.groupName ? (
                <span className="net-frp-figure">
                  用户组 <strong>{user.groupName}</strong>
                </span>
              ) : null}
            </div>

            <div className="net-frp-sign" data-frp-sign>
              <span
                className={`badge ${user.signed ? "net-frp-signed" : "muted-tag"}`}
                data-frp-signed={user.signed ? "true" : "false"}
              >
                {user.signed ? <IconCheck size={12} /> : null}
                {user.signed ? `今日已签到${user.signDays !== undefined ? ` · 连续 ${user.signDays} 天` : ""}` : "今日未签到"}
              </span>
              <span className="net-frp-sign-note" data-frp-sign-hint>签到请在 natfrp.com 网页完成</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openSite()} data-frp-open-site>
                <IconLink size={14} />
                打开 natfrp.com
              </button>
            </div>
          </div>
        ) : null}

      </div>

      {savedToken ? (
        <div className="panel" data-frp-card="tunnels">
          <div className="panel-head">
            <h2 className="panel-title">隧道</h2>
            <span className="panel-count">{tunnels.length} 条</span>
            <div className="net-frp-head-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => tunnelList.reload()} disabled={tunnelList.loading} data-frp-tunnels-reload>
                <IconRefresh size={15} />
                刷新
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={openCreate} data-frp-create-open>
                <IconPlus size={15} />
                新建隧道
              </button>
            </div>
          </div>

          {tunnelList.loading && tunnels.length === 0 ? <SkeletonRows count={2} /> : null}
          {tunnelList.error ? <ErrorState message={tunnelList.error} onRetry={tunnelList.reload} /> : null}
          {!tunnelList.loading && !tunnelList.error && tunnels.length === 0 ? (
            <EmptyState title="还没有隧道" hint="点「新建隧道」把本地 25565 映射到公网，好友用公网地址直连。" />
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
                        {tunnel.online ? "在线" : "离线"}
                      </span>
                    </div>
                    <div className="net-frp-row-meta">
                      <span data-frp-node>{tunnel.nodeName ?? `节点 #${tunnel.node}`}</span>
                      <span>
                        本地端口 <code className="net-frp-port">{tunnel.localPort}</code>
                      </span>
                    </div>
                    <div className="net-frp-row-actions">
                      {isRunning ? (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void stopTunnel()} disabled={busy} data-frp-stop>
                          停止
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => void startTunnel(tunnel)}
                          disabled={busy}
                          data-frp-start={tunnel.id}
                        >
                          启动
                        </button>
                      )}
                    </div>
                    {address ? (
                      <div className="net-frp-row-addr" data-frp-address={address}>
                        <span className="net-frp-addr-label">公网地址</span>
                        <code className="net-addr-value">{address}</code>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(address)} data-frp-copy>
                          复制
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
            title="还没有配置樱花穿透"
            hint="填好并保存访问密钥后，这里会列出你的隧道和公网地址。"
            action={
              <button type="button" className="btn btn-primary" onClick={focusTokenInput} data-frp-guide-action>
                去填写访问密钥
              </button>
            }
          />
        </div>
      )}

      <Modal
        open={createOpen}
        title="新建隧道"
        subtitle="把本机的 Minecraft 端口映射到公网"
        onClose={() => setCreateOpen(false)}
        width={480}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void submitCreate()} disabled={creating} data-frp-create-submit>
              {creating ? "创建中…" : "创建"}
            </button>
          </>
        }
      >
        <div className="net-frp-form">
          <Field label="隧道名">
            <TextInput
              value={createName}
              aria-label="隧道名"
              data-frp-create-name
              spellCheck={false}
              onChange={(event) => setCreateName(event.target.value)}
            />
          </Field>
          <Field label="本地端口" hint="游戏里「对局域网开放」的端口，默认 25565">
            <TextInput
              value={createPort}
              inputMode="numeric"
              aria-label="本地端口"
              data-frp-create-port
              onChange={(event) => setCreatePort(event.target.value)}
            />
          </Field>
          <Field label="节点" hint="公开宣传的房间必须选满足「公开游戏服务器」的节点">
            <Select
              value={createNode}
              options={nodeOptions}
              onChange={setCreateNode}
              ariaLabel="节点"
              placeholder={nodeList.loading ? "节点加载中…" : "请选择节点"}
            />
          </Field>
          {selectedNode && !selectedNode.publicGameAllowed ? (
            <p className="net-frp-warn" data-frp-node-warn>
              {selectedNode.name} 不满足「公开游戏服务器」要求：只适合小群熟人联机，公开宣传可能被封禁。
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
