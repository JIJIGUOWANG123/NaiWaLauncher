import { useEffect, useRef, useState } from "react";
import type { DeviceCodeChallenge } from "../../shared/types";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { useApp } from "../lib/store";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { Field, TextInput } from "../components/Form";

const AZURE_URL = "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
const APPROVAL_URL = "https://help.minecraft.net/hc/en-us/articles/16254801392141";
/** 轮询失败时按错误关键字分流到不同的引导卡片。 */
type GuideKind = "appid" | "aadsts";

function guideFor(message: string): GuideKind | null {
  if (message.includes("Invalid app registration") || message.includes("AppID 审批")) return "appid";
  if (message.includes("AADSTS70002")) return "aadsts";
  return null;
}

/** Mojang AppID 审批用的申请模板：一行一个 key，client id 用当前设置值填充。 */
function applicationTemplate(clientId: string): string {
  return [
    `Application (client) ID: ${clientId}`,
    "Application name: NaiWa Launcher (奶娃启动器)",
    "Application type: Public client (desktop, device code flow)",
    "Accounts supported: Personal Microsoft accounts",
    "Requested scope: XboxLive.signin, offline_access",
    "Purpose: Non-commercial open-source Minecraft Java launcher; authenticates the user's own account to launch the game they own.",
  ].join("\n");
}

/** 微软账号卡片：client id 保存 + 设备码登录（自动复制/开浏览器、轮询、倒计时、失败引导）。 */
export function MicrosoftAccountCard({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { settings, applySettings } = useApp();
  const { push } = useToast();
  const saved = settings?.microsoftClientIdManual ?? "";
  const effectiveClientId = (saved.trim() || settings?.microsoftClientId || "").trim();
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [challenge, setChallenge] = useState<DeviceCodeChallenge | null>(null);
  const [polling, setPolling] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [polls, setPolls] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [guide, setGuide] = useState<GuideKind | null>(null);
  // 上级回调每次渲染都是新函数，放进 ref 才不会让轮询 effect 反复重启。
  const loggedInRef = useRef(onLoggedIn);
  loggedInRef.current = onLoggedIn;

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  useEffect(() => {
    if (!challenge || !polling) return;
    const timer = window.setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [challenge, polling]);

  useEffect(() => {
    if (!challenge || !polling || remaining > 0) return;
    setPolling(false);
    setError("设备码已过期，请重新登录。");
    setGuide(null);
    push("设备码已过期，请重新登录。", "error");
  }, [challenge, polling, remaining, push]);

  const intervalMs = Math.max(1, challenge?.interval ?? 5) * 1000;

  useEffect(() => {
    if (!challenge || !polling) return;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const state = await api.accounts.pollMicrosoft(challenge.deviceCode);
        if (!alive) return;
        setPolls((value) => value + 1);
        if (state.status === "pending") {
          timer = window.setTimeout(() => void tick(), intervalMs);
          return;
        }
        setPolling(false);
        if (state.status === "ok") {
          setChallenge(null);
          setError(null);
          setGuide(null);
          push(`微软账号「${state.account.name}」登录成功`, "success");
          loggedInRef.current();
          return;
        }
        setError(state.message);
        setGuide(guideFor(state.message));
        push(state.message, "error");
      } catch (failure: unknown) {
        if (!alive) return;
        setPolling(false);
        const message = errorMessage(failure);
        setError(message);
        setGuide(guideFor(message));
        push(message, "error");
      }
    };
    timer = window.setTimeout(() => void tick(), intervalMs);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [challenge, polling, intervalMs, push]);

  const openExternal = async (url: string) => {
    try {
      await api.app.openExternal(url);
    } catch (failure: unknown) {
      push(errorMessage(failure), "error");
    }
  };

  // 优先走主进程剪贴板（file:// 下 navigator.clipboard 常不可用），失败再退回浏览器兜底。
  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      await api.app.copyText(text);
      return true;
    } catch {
      return copyText(text);
    }
  };

  const recopyCode = async (code: string) => {
    const ok = await copyToClipboard(code);
    push(ok ? `代码 ${code} 已复制` : "复制失败，请手动复制设备码", ok ? "success" : "error");
  };

  const copyTemplate = async () => {
    const ok = await copyToClipboard(applicationTemplate(effectiveClientId));
    push(ok ? "申请模板已复制，可直接粘贴到审批表单" : "复制失败，请手动复制模板", ok ? "success" : "error");
  };

  const saveClientId = async () => {
    setSaving(true);
    try {
      const next = await api.settings.update({ microsoftClientIdManual: draft.trim() });
      const reread = await api.settings.get();
      if ((reread.microsoftClientIdManual ?? "") !== (next.microsoftClientIdManual ?? "")) {
        throw new Error("client id 保存后回读不一致，请重试。");
      }
      applySettings(reread);
      setDraft(reread.microsoftClientIdManual ?? "");
      push((reread.microsoftClientIdManual ?? "").trim() ? "已保存自定义 client id，将不再使用内置 id" : "已清空自定义 id，改回使用内置公共 id", "success");
    } catch (failure: unknown) {
      push(errorMessage(failure), "error");
    } finally {
      setSaving(false);
    }
  };

  const startLogin = async () => {
    // 留空时后端回退到内置公共 client id，这里不做拦截。
    setStarting(true);
    setError(null);
    setGuide(null);
    try {
      const next = await api.accounts.beginMicrosoft();
      setPolls(0);
      setRemaining(next.expiresIn);
      setChallenge(next);
      setPolling(true);
      // 设备码登录最省事的一步：代码进剪贴板、浏览器直接打开，用户只需粘贴并授权。
      const copied = await copyToClipboard(next.userCode);
      await openExternal(next.verificationUri);
      push(`代码 ${next.userCode} 已复制，浏览器已打开；粘贴后完成授权`, copied ? "success" : "info");
      if (!copied) push("复制失败，请手动复制设备码", "error");
    } catch (failure: unknown) {
      const message = errorMessage(failure);
      setError(message);
      setGuide(guideFor(message));
      push(message, "error");
    } finally {
      setStarting(false);
    }
  };

  const cancelLogin = () => {
    setPolling(false);
    setChallenge(null);
    setRemaining(0);
    push("已取消微软登录", "info");
  };

  // 留空时使用内置公共 id，因此只要生效值存在就允许点击登录
  const hasClientId = effectiveClientId.length > 0;
  const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  return (
    <section className="panel account-add" aria-label="微软账号">
      <div className="panel-head">
        <h2 className="panel-title">微软账号</h2>
        <span className="panel-count">设备码登录</span>
      </div>

      <p className="account-note">
        需在 Azure 门户注册应用，重定向类型选「公共客户端」，API 权限勾选 XboxLive.signin；把应用 ID 填在这里。
        <button type="button" className="account-link" onClick={() => void openExternal(AZURE_URL)}>
          打开 Azure 门户
        </button>
      </p>

      <Field
        label="Azure 应用 client id"
        hint="留空则使用内置公共 client id；填入自己的 id 后将**不再**使用内置。报 AADSTS70002 需在 Azure 门户开启「允许公共客户端流」，报 AppID 审批需向 Mojang 提交申请。"
      >
        <div className="account-row">
          <TextInput
            value={draft}
            aria-label="微软 client id"
            placeholder="留空 = 使用内置公共 client id"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void saveClientId()}
            disabled={saving || draft.trim() === saved}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </Field>

      {challenge ? (
        <div className="device-code" aria-label="设备码登录">
          <span className="device-code-label">代码已复制、浏览器已打开，粘贴到页面即可完成授权</span>
          <strong className="device-code-value" data-device-user-code>{challenge.userCode}</strong>
          <button
            type="button"
            className="account-link"
            onClick={() => void openExternal(challenge.verificationUri)}
            data-verification-uri
          >
            {challenge.verificationUri}
          </button>
          <p className="device-code-meta" data-device-meta>
            {polling ? `等待授权… 剩余 ${clock} · 已轮询 ${polls} 次` : "已停止轮询"}
          </p>
          <div className="account-row">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void recopyCode(challenge.userCode)}
              data-copy-code
            >
              重新复制
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void openExternal(challenge.verificationUri)}
              data-open-browser
            >
              重新打开
            </button>
            <button type="button" className="btn btn-ghost btn-danger-ghost btn-sm" onClick={cancelLogin}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="account-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void startLogin()}
            disabled={starting || polling || !hasClientId}
          >
            {starting ? "正在获取设备码…" : "使用微软账号登录"}
          </button>
          
        </div>
      )}

      {guide === "appid" ? (
        <div className="ms-guide" role="alert" data-guide="appid">
          <p className="ms-guide-title">该 Azure 应用需通过 Mojang AppID 审批</p>
          <p className="ms-guide-text">
            Mojang 只给通过审批的公共客户端应用发放 Minecraft 登录权限。可以先复制申请模板提交审批，或把 client id
            换成你自己已获批的应用。
          </p>
          <div className="account-row">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void openExternal(APPROVAL_URL)}
              data-approval-link
            >
              打开审批说明页
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyTemplate()} data-copy-template>
              复制申请模板
            </button>
          </div>
        </div>
      ) : null}

      {guide === "aadsts" ? (
        <div className="ms-guide" role="alert" data-guide="aadsts">
          <p className="ms-guide-title">到 Azure 门户开启允许公共客户端流</p>
          <p className="ms-guide-text">
            AADSTS70002 说明该应用没开启公共客户端（设备码）流：在 Azure 门户 → 应用 → 身份验证里把「允许公共客户端流」
            设为「是」并保存，然后重新登录。
          </p>
          <div className="account-row">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void openExternal(AZURE_URL)}
              data-azure-link
            >
              打开 Azure 门户
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="account-error" role="alert" data-account-error>{error}</p> : null}
    </section>
  );
}
