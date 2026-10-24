import { useMemo, useState } from "react";
import type { LanAddress } from "../../shared/types";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { useT } from "../lib/i18n";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorState, SkeletonRows } from "../components/State";
import { OfflineLanNotice } from "../components/OfflineLanNotice";
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
  const t = useT();
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
    if (ok) push(t("pages.netLan.copied", { target }), "success");
    else push(t("pages.netLan.copyFailed"), "error");
  };

  const runPortCheck = async () => {
    setChecking(true);
    try {
      const open = await api.net.portCheck(sharePort);
      setListening(open);
      push(
        open
          ? t("pages.netLan.portOpen", { port: String(sharePort) })
          : t("pages.netLan.portClosed", { port: String(sharePort) }),
        open ? "success" : "info",
      );
    } catch (error: unknown) {
      setListening(null);
      push(errorMessage(error), "error");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <OfflineLanNotice side="host" />

      <div className="panel" data-net-card="lan">
        <div className="panel-head">
          <h2 className="panel-title">
            <span className="net-icon"><IconWifi size={17} /></span>
            {t("pages.netLan.title")}
          </h2>
          <span className="panel-count">
            {t("pages.netLan.addressCount", { count: String(addresses.length) })}
          </span>
          <div className="net-head-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => interfaces.reload()}
              disabled={interfaces.loading}
            >
              <IconRefresh size={15} />
              {t("pages.netLan.refresh")}
            </button>
          </div>
        </div>

        {interfaces.loading ? <SkeletonRows count={2} /> : null}
        {interfaces.error ? <ErrorState message={interfaces.error} onRetry={interfaces.reload} /> : null}
        {!interfaces.loading && !interfaces.error && addresses.length === 0 ? (
          <EmptyState title={t("pages.netLan.noAddressTitle")} hint={t("pages.netLan.noAddressHint")} />
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
                    {t("pages.netLan.copy")}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        <div className="net-inline-form">
          <Field label={t("pages.netLan.portLabel")} hint={t("pages.netLan.portHint")}>
            <TextInput
              value={portDraft}
              inputMode="numeric"
              aria-label={t("pages.netLan.portAria")}
              data-net-port="share"
              onChange={(event) => {
                setPortDraft(event.target.value);
                setListening(null);
              }}
            />
          </Field>
        </div>

        <p className="net-note">{t("pages.netLan.note")}</p>
      </div>

      <div className="panel" data-net-card="check">
        <div className="panel-head">
          <h2 className="panel-title">{t("pages.netLan.checkTitle")}</h2>
          <span className="panel-count">{t("pages.netLan.checkSub")}</span>
        </div>

        <div className="net-inline-form">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void runPortCheck()}
            disabled={checking}
            data-net-check
          >
            {checking ? t("pages.netLan.checking") : t("pages.netLan.checkAction", { port: String(sharePort) })}
          </button>
        </div>

        {listening === true ? (
          <p className="net-result ok" role="status" data-net-check-result="true">
            <IconCheck size={15} />
            {t("pages.netLan.listening")}
          </p>
        ) : null}
        {listening === false ? (
          <p className="net-result bad" role="status" data-net-check-result="false">
            {t("pages.netLan.notListening")}
          </p>
        ) : null}
        {listening === null && !checking ? (
          <p className="net-note">{t("pages.netLan.notChecked")}</p>
        ) : null}
      </div>
    </>
  );
}
