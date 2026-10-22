import { useMemo, useState } from "react";
import type { LanAddress } from "../../shared/types";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorState, SkeletonRows } from "../components/State";
import { Field, TextInput } from "../components/Form";
import { IconCheck, IconRefresh, IconWifi } from "../components/icons";

const DEFAULT_PORT = 25565;

/** 端口输入框：只允许 1-65535，越界按默认值兜底，避免把 NaN 传给主进程。 */
function parsePort(raw: string, fallback = DEFAULT_PORT): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > 65535) return fallback;
  return value;
}

export function NetLanTab() {
  const { push } = useToast();
  const interfaces = useAsync(() => api.net.interfaces(), []);

  // 联机端口：分享地址与「开房检查」共用同一个值，默认 25565。
  const [portDraft, setPortDraft] = useState(String(DEFAULT_PORT));
  const sharePort = parsePort(portDraft);

  const [checking, setChecking] = useState(false);
  const [listening, setListening] = useState<boolean | null>(null);

  const addresses: LanAddress[] = useMemo(() => interfaces.data ?? [], [interfaces.data]);

  // 优先走主进程剪贴板（file:// 下 navigator.clipboard 常不可用），失败再退回浏览器兜底。
  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      await api.app.copyText(text);
      return true;
    } catch {
      return copyText(text);
    }
  };

  const copy = async (target: string) => {
    const ok = await copyToClipboard(target);
    if (ok) push(`已复制 ${target}`, "success");
    else push("复制失败，请手动选中地址复制", "error");
  };

  const runPortCheck = async () => {
    setChecking(true);
    try {
      const open = await api.net.portCheck(sharePort);
      setListening(open);
      push(open ? `${sharePort} 已开放` : `${sharePort} 还没有在监听`, open ? "success" : "info");
    } catch (error: unknown) {
      setListening(null);
      push(errorMessage(error), "error");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <div className="panel" data-net-card="lan">
        <div className="panel-head">
          <h2 className="panel-title">
            <span className="net-icon"><IconWifi size={17} /></span>
            局域网联机
          </h2>
          <span className="panel-count">{addresses.length} 个可用地址</span>
          <div className="net-head-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => interfaces.reload()}
              disabled={interfaces.loading}
            >
              <IconRefresh size={15} />
              刷新
            </button>
          </div>
        </div>

        {interfaces.loading ? <SkeletonRows count={2} /> : null}
        {interfaces.error ? <ErrorState message={interfaces.error} onRetry={interfaces.reload} /> : null}
        {!interfaces.loading && !interfaces.error && addresses.length === 0 ? (
          <EmptyState title="没有找到可用的局域网地址" hint="确认这台电脑已经连上 Wi-Fi 或有线网络，然后点「刷新」重试。" />
        ) : null}

        {addresses.length > 0 ? (
          <ul className="net-addr-list">
            {addresses.map((item) => {
              const target = `${item.address}:${sharePort}`;
              return (
                <li className="net-addr-row" key={`${item.name}-${item.address}`} data-net-address={item.address}>
                  <div className="net-addr-main">
                    <span className="net-addr-name">{item.name}</span>
                    <span className="net-addr-family">{item.family}</span>
                  </div>
                  <code className="net-addr-value" data-net-target={target}>{target}</code>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void copy(target)}
                    data-net-copy={target}
                  >
                    复制
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        <div className="net-inline-form">
          <Field label="分享给好友的端口" hint="默认 25565；改了游戏里的端口这里也要跟着改">
            <TextInput
              value={portDraft}
              inputMode="numeric"
              aria-label="联机端口"
              data-net-port="share"
              onChange={(event) => {
                setPortDraft(event.target.value);
                setListening(null);
              }}
            />
          </Field>
        </div>

        <p className="net-note">
          同一局域网内，好友在「多人游戏 → 直接连接」里填这个地址就能进你的房间。
        </p>
      </div>

      <div className="panel" data-net-card="check">
        <div className="panel-head">
          <h2 className="panel-title">开房检查</h2>
          <span className="panel-count">只检查这台电脑自己的端口</span>
        </div>

        <div className="net-inline-form">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void runPortCheck()}
            disabled={checking}
            data-net-check
          >
            {checking ? "检查中…" : `检查 ${sharePort} 是否已开放`}
          </button>
        </div>

        {listening === true ? (
          <p className="net-result ok" role="status" data-net-check-result="true">
            <IconCheck size={15} />
            本机已在监听，好友可以连了
          </p>
        ) : null}
        {listening === false ? (
          <p className="net-result bad" role="status" data-net-check-result="false">
            请先在游戏里点「对局域网开放」
          </p>
        ) : null}
        {listening === null && !checking ? (
          <p className="net-note">还没检查。先在游戏里开好房间，再点上面的按钮。</p>
        ) : null}
      </div>
    </>
  );
}
