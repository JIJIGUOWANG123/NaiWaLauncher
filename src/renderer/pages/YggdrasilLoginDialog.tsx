import { useEffect, useState } from "react";
import type { Account } from "../../shared/types";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/useAsync";
import { Field, TextInput } from "../components/Form";
import { Modal } from "../components/Modal";
import { IconEye, IconEyeOff } from "../components/icons";

/** 快捷按钮与输入框默认值都用 LittleSkin：国内最常用的 authlib-injector 服务端。 */
export const LITTLESKIN_API_URL = "https://littleskin.cn/api/yggdrasil";

/**
 * 第三方账号登录弹窗。
 * 「在此设备上保存登录」不勾选时仍然走同一条登录链路（凭据要落盘才能启动游戏），
 * 但账号会在本会话内被标注为「临时」账号——说明文案里写清了这一点。
 */
export function YggdrasilLoginDialog({
  open, onClose, onLoggedIn,
}: {
  open: boolean;
  onClose: () => void;
  onLoggedIn: (account: Account, temporary: boolean) => void;
}) {
  const t = useT();
  const [apiUrl, setApiUrl] = useState(LITTLESKIN_API_URL);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saveLogin, setSaveLogin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都从干净状态开始，避免上次的密码和红字残留。
  useEffect(() => {
    if (!open) return;
    setApiUrl(LITTLESKIN_API_URL);
    setUsername("");
    setPassword("");
    setShowPassword(false);
    setSaveLogin(true);
    setBusy(false);
    setError(null);
  }, [open]);

  const submit = async () => {
    if (busy) return;
    const trimmedUrl = apiUrl.trim();
    const trimmedUser = username.trim();
    if (!trimmedUrl) {
      setError(t("pages.yggdrasil.errApiUrl"));
      return;
    }
    if (!trimmedUser) {
      setError(t("pages.yggdrasil.errUser"));
      return;
    }
    if (!password) {
      setError(t("pages.yggdrasil.errPassword"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const account = await api.accounts.loginYggdrasil(trimmedUrl, trimmedUser, password);
      onLoggedIn(account, !saveLogin);
    } catch (failure: unknown) {
      // 失败时保留弹窗，把后端错误原文贴在输入区下方。
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("pages.yggdrasil.title")}
      subtitle={t("pages.yggdrasil.subtitle")}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy} data-ygg-cancel>
            {t("pages.common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-ygg-submit>
            {busy ? t("pages.yggdrasil.signingIn") : t("pages.yggdrasil.signIn")}
          </button>
        </>
      }
    >
      <div className="ygg-quick">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setApiUrl(LITTLESKIN_API_URL)}
          data-ygg-quick
        >
          {t("pages.yggdrasil.useLittleSkin")}
        </button>
        <span className="ygg-quick-hint">{t("pages.yggdrasil.quickHint")}</span>
      </div>

      <Field label={t("pages.yggdrasil.apiLabel")} hint={t("pages.yggdrasil.apiHint")}>
        <TextInput
          value={apiUrl}
          placeholder={LITTLESKIN_API_URL}
          aria-label={t("pages.yggdrasil.apiLabel")}
          spellCheck={false}
          data-ygg-api
          onChange={(event) => setApiUrl(event.target.value)}
        />
      </Field>

      <Field label={t("pages.yggdrasil.userLabel")}>
        <TextInput
          value={username}
          placeholder={t("pages.yggdrasil.userPlaceholder")}
          aria-label={t("pages.yggdrasil.userAria")}
          autoComplete="username"
          spellCheck={false}
          data-ygg-user
          onChange={(event) => setUsername(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
      </Field>

      <Field label={t("pages.yggdrasil.passLabel")}>
        <div className="account-row">
          <TextInput
            type={showPassword ? "text" : "password"}
            value={password}
            placeholder={t("pages.yggdrasil.passPlaceholder")}
            aria-label={t("pages.yggdrasil.passAria")}
            autoComplete="current-password"
            data-ygg-pass
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={showPassword ? t("pages.yggdrasil.hidePassword") : t("pages.yggdrasil.showPassword")}
            data-ygg-toggle
          >
            {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
          </button>
        </div>
      </Field>

      <label className="account-check">
        <input
          type="checkbox"
          checked={saveLogin}
          data-ygg-save
          onChange={(event) => setSaveLogin(event.target.checked)}
        />
        {t("pages.yggdrasil.saveLogin")}
      </label>
      <p className="ygg-hint">{t("pages.yggdrasil.saveHint")}</p>

      {error ? (
        <p className="account-error" role="alert" data-ygg-error>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
