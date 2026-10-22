import { useCallback, useEffect, useState } from "react";
import type { Account, SkinInfo } from "../../shared/types";
import { accountSiteName } from "../lib/account";
import { api } from "../lib/api";
import { errorMessage } from "../lib/useAsync";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { IconImage, IconRefresh } from "../components/icons";

type SkinModel = "classic" | "slim";

const MODEL_LABEL: Record<SkinModel, string> = { classic: "Steve", slim: "Alex" };
/** 弹窗底部说明：像素尺寸与第三方托管规则。 */
const NOTE = "皮肤需为 64×64（或 64×32）的 PNG；第三方账号的皮肤由对应皮肤站托管。";
const NO_UPLOAD_HINT = "该账号暂时不能编辑皮肤。";

/** 本地图片路径 → file: URL（Windows 反斜杠换正斜杠，空格/中文交给 encodeURI）。 */
function fileUrl(target: string): string {
  return encodeURI(`file:///${target.replace(/\\/g, "/")}`);
}

function fileNameOf(target: string): string {
  const parts = target.split(/[\\/]/);
  return parts[parts.length - 1] || target;
}

/** 来源标签：微软账号走 Mojang，第三方账号用皮肤站名。 */
function sourceLabel(account: Account, info: SkinInfo): string {
  if (info.source === "mojang") return "Mojang";
  if (info.source === "yggdrasil") return accountSiteName(account) || "第三方皮肤站";
  return "无";
}

export function SkinDialog({ account, onClose }: {
  account: Account | null;
  onClose(): void;
}) {
  const { push } = useToast();
  const [info, setInfo] = useState<SkinInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [localBroken, setLocalBroken] = useState(false);
  const [model, setModel] = useState<SkinModel>("classic");
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const accountId = account?.id ?? null;

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await api.accounts.skin(id);
      setInfo(next);
      setModel(next.model ?? "classic");
    } catch (error: unknown) {
      setInfo(null);
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开弹窗或切换账号：清掉上一次的选择，重新读一次皮肤。
  useEffect(() => {
    if (!accountId) return;
    setPicked(null);
    setLocalBroken(false);
    setConfirmReset(false);
    setInfo(null);
    void load(accountId);
  }, [accountId, load]);

  const pick = async () => {
    setPicking(true);
    try {
      const target = await api.accounts.pickSkinFile();
      if (!target) return;
      setPicked(target);
      setLocalBroken(false);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setPicking(false);
    }
  };

  const apply = async () => {
    if (!account || !picked) return;
    setUploading(true);
    try {
      await api.accounts.uploadSkin(account.id, picked, model);
      push("皮肤已更新", "success");
      setPicked(null);
      setLocalBroken(false);
      await load(account.id);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setUploading(false);
    }
  };

  const reset = async () => {
    if (!account) return;
    setConfirmReset(false);
    setResetting(true);
    try {
      await api.accounts.resetSkin(account.id);
      push("已恢复默认皮肤", "success");
      setPicked(null);
      setLocalBroken(false);
      await load(account.id);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setResetting(false);
    }
  };

  // 读取失败时不禁用操作区：用户仍可重试，错误原因单独显示。
  const blocked = info ? !info.canUpload : false;
  const busy = picking || uploading || resetting;

  return (
    <Modal
      open={Boolean(account)}
      title="皮肤选择器"
      subtitle={account ? `账号「${account.name}」的皮肤` : undefined}
      width={560}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-ghost" onClick={onClose} data-skin-close>
          关闭
        </button>
      }
    >
      {account ? (
        <div className="skin-dialog">
          <div className="skin-preview-row">
            <div className="skin-preview" data-skin-preview-box>
              {loading && !info ? (
                <span className="skin-preview-hint">读取中…</span>
              ) : info?.skinUrl ? (
                <img className="skin-preview-img" src={info.skinUrl} alt="当前皮肤" data-skin-preview />
              ) : (
                <span className="skin-preview-hint" data-skin-preview-empty>
                  {loadError ? "皮肤读取失败" : "该账号没有可预览的皮肤"}
                </span>
              )}
            </div>
            <div className="skin-meta">
              <div className="skin-meta-item">
                <span className="skin-meta-label">模型</span>
                <span className="skin-meta-value" data-skin-model>
                  {MODEL_LABEL[info?.model ?? model]}
                </span>
              </div>
              <div className="skin-meta-item">
                <span className="skin-meta-label">来源</span>
                <span className="skin-meta-value" data-skin-source>
                  {info ? sourceLabel(account, info) : "—"}
                </span>
              </div>
              {info?.capeUrl ? (
                <div className="skin-meta-item">
                  <span className="skin-meta-label">披风</span>
                  <span className="skin-meta-value">已启用</span>
                </div>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost btn-sm skin-refresh"
                onClick={() => void load(account.id)}
                disabled={loading || busy}
                data-skin-reload
              >
                <IconRefresh size={14} />
                重新读取
              </button>
            </div>
          </div>

          {loadError ? (
            <p className="skin-error" role="alert" data-skin-load-error>
              读取皮肤失败：{loadError}
            </p>
          ) : null}

          {blocked ? (
            <p className="skin-error" role="alert" data-skin-blocked>
              {info?.error?.trim() || NO_UPLOAD_HINT}
            </p>
          ) : null}

          <div className="skin-ops">
            <div className="skin-pick-row">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void pick()}
                disabled={blocked || picking || uploading || resetting}
                data-skin-pick
              >
                <IconImage size={14} />
                {picking ? "选择中…" : "选择皮肤文件"}
              </button>
              {picked ? (
                <span className="skin-file" data-skin-file-name title={picked}>
                  {fileNameOf(picked)}
                </span>
              ) : (
                <span className="skin-file-hint">未选择文件</span>
              )}
            </div>

            {picked ? (
              <div className="skin-local" data-skin-local>
                {localBroken ? (
                  <span className="skin-local-hint" data-skin-local-broken>
                    无法预览本地文件
                  </span>
                ) : (
                  <img
                    className="skin-local-img"
                    src={fileUrl(picked)}
                    alt="本地皮肤预览"
                    data-skin-local-img
                    onError={() => setLocalBroken(true)}
                  />
                )}
                <span className="skin-local-hint">本地预选（尚未上传）</span>
              </div>
            ) : null}

            <div className="skin-models" role="radiogroup" aria-label="皮肤模型">
              <span className="skin-meta-label">模型</span>
              {(Object.keys(MODEL_LABEL) as SkinModel[]).map((value) => (
                <label
                  key={value}
                  className={`skin-model ${model === value ? "active" : ""} ${blocked ? "is-disabled" : ""}`.trim()}
                >
                  <input
                    type="radio"
                    name="skin-model"
                    value={value}
                    checked={model === value}
                    disabled={blocked || busy}
                    onChange={() => setModel(value)}
                    data-skin-model-input={value}
                  />
                  {MODEL_LABEL[value]}（{value}）
                </label>
              ))}
            </div>

            <div className="skin-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void apply()}
                disabled={blocked || !picked || uploading || resetting || picking}
                data-skin-apply
              >
                {uploading ? "上传中…" : "应用皮肤"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-danger-ghost"
                onClick={() => setConfirmReset(true)}
                disabled={blocked || uploading || resetting || picking}
                data-skin-reset
              >
                {resetting ? "恢复中…" : "恢复默认"}
              </button>
            </div>
          </div>

          <p className="skin-note" data-skin-note>
            {NOTE}
          </p>

          <ConfirmDialog
            open={confirmReset}
            title="恢复默认皮肤"
            message={`确定把「${account.name}」的皮肤恢复为默认皮肤吗？当前皮肤会被覆盖。`}
            confirmText="恢复默认"
            busyText="恢复中…"
            danger
            busy={resetting}
            onCancel={() => setConfirmReset(false)}
            onConfirm={() => void reset()}
          />
        </div>
      ) : null}
    </Modal>
  );
}
