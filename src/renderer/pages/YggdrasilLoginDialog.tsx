import { useEffect, useState } from "react";
import type { Account } from "../../shared/types";
import { api } from "../lib/api";
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
      setError("请填写 Yggdrasil API 地址。");
      return;
    }
    if (!trimmedUser) {
      setError("请填写账号或邮箱。");
      return;
    }
    if (!password) {
      setError("请填写密码。");
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
      title="登录第三方账号"
      subtitle="使用 LittleSkin 或其他兼容的 Yggdrasil 外置登录服务。"
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy} data-ygg-cancel>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-ygg-submit>
            {busy ? "登录中…" : "登录"}
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
          使用 LittleSkin
        </button>
        <span className="ygg-quick-hint">默认已填 LittleSkin，换其它兼容服务时改下面的地址即可</span>
      </div>

      <Field label="Yggdrasil API 地址" hint="兼容 authlib-injector 的服务都可用，通常以 /api/yggdrasil 结尾。">
        <TextInput
          value={apiUrl}
          placeholder={LITTLESKIN_API_URL}
          aria-label="Yggdrasil API 地址"
          spellCheck={false}
          data-ygg-api
          onChange={(event) => setApiUrl(event.target.value)}
        />
      </Field>

      <Field label="账号或邮箱">
        <TextInput
          value={username}
          placeholder="LittleSkin 用户名或注册邮箱"
          aria-label="第三方账号或邮箱"
          autoComplete="username"
          spellCheck={false}
          data-ygg-user
          onChange={(event) => setUsername(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
      </Field>

      <Field label="密码">
        <div className="account-row">
          <TextInput
            type={showPassword ? "text" : "password"}
            value={password}
            placeholder="账号密码"
            aria-label="第三方账号密码"
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
            aria-label={showPassword ? "隐藏密码" : "显示密码"}
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
        在此设备上保存登录
      </label>
      <p className="ygg-hint">
        不勾选时账号只用于本次会话：凭据仍会写入本机（否则无法启动游戏），账号会标注为「临时」，关闭启动器后不再保留这个标记。
      </p>

      {error ? (
        <p className="account-error" role="alert" data-ygg-error>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
