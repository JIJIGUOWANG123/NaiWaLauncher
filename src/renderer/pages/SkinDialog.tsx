import { useCallback, useEffect, useState } from "react";
import type { Account, SkinInfo, SkinProfile, WardrobeSkin } from "../../shared/types";
import { accountSiteName } from "../lib/account";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { errorMessage } from "../lib/useAsync";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { IconClose, IconImage, IconPlus, IconRefresh } from "../components/icons";

type SkinModel = "classic" | "slim";

/** 待上传的皮肤：可能来自文件框，也可能来自衣柜里已选中的那张。 */
interface PickedSkin {
  /** 传给 uploadSkin 的路径。 */
  path: string;
  /** 预览用直链（file: 或 data:）。 */
  url: string;
  /** 显示用的文件名。 */
  name: string;
  from: "file" | "wardrobe";
}

const MODEL_LABEL: Record<SkinModel, string> = { classic: "Steve", slim: "Alex" };
/** 弹窗底部说明：像素尺寸与第三方托管规则。 */
const NOTE = "皮肤需为 64×64（或 64×32）的 PNG；第三方账号的皮肤由对应皮肤站托管。";
const NO_UPLOAD_HINT = "该账号暂时不能编辑皮肤。";
const WARDROBE_EMPTY = "衣柜是空的。可以把 64×64 的 PNG 放进来，或从文件添加。";

/** 本地图片路径 → file: URL（Windows 反斜杠换正斜杠，空格/中文交给 encodeURI）。 */
function fileUrl(target: string): string {
  return encodeURI(`file:///${target.replace(/\\/g, "/")}`);
}

function fileNameOf(target: string): string {
  const parts = target.split(/[\\/]/);
  return parts[parts.length - 1] || target;
}

/**
 * 衣柜项 → 可上传的本地路径。主进程给的是 file:// 直链，这里解码回绝对路径；
 * 拿不到本地路径（mock 的 data: 缩略图）时退回文件名，由主进程按衣柜目录解析。
 */
function wardrobePath(item: WardrobeSkin): string {
  if (!item.url.startsWith("file:")) return item.name;
  const raw = decodeURI(item.url.replace(/^file:\/+/, ""));
  return /^[A-Za-z]:/.test(raw) ? raw.replace(/\//g, "\\") : raw;
}

/** 角色头像色块：UUID 前 8 位决定色相，同一个角色每次都是同一种颜色。 */
function avatarColor(uuid: string): string {
  const seed = Number.parseInt(uuid.replace(/-/g, "").slice(0, 8), 16);
  const hue = Number.isFinite(seed) ? seed % 360 : 0;
  return `hsl(${hue} 52% 46%)`;
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
  const [picked, setPicked] = useState<PickedSkin | null>(null);
  const [localBroken, setLocalBroken] = useState(false);
  const [model, setModel] = useState<SkinModel>("classic");
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // 角色：只有第三方账号才有多个角色，单角色时只显示一行文字。
  const [profiles, setProfiles] = useState<SkinProfile[]>([]);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  // 衣柜：本机 NaiWa/skins 下的图片，选中后直接作为待上传皮肤。
  const [wardrobe, setWardrobe] = useState<WardrobeSkin[] | null>(null);
  const [wardrobeLoading, setWardrobeLoading] = useState(false);
  const [wardrobeError, setWardrobeError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<WardrobeSkin | null>(null);
  const [deleting, setDeleting] = useState(false);

  const accountId = account?.id ?? null;
  const thirdParty = account?.type === "yggdrasil";

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

  const loadProfiles = useCallback(async (id: string) => {
    setProfileError(null);
    try {
      setProfiles(await api.accounts.skinProfiles(id));
    } catch (error: unknown) {
      setProfiles([]);
      setProfileError(errorMessage(error));
    }
  }, []);

  const loadWardrobe = useCallback(async () => {
    setWardrobeLoading(true);
    setWardrobeError(null);
    try {
      setWardrobe(await api.accounts.wardrobe());
    } catch (error: unknown) {
      setWardrobe(null);
      setWardrobeError(errorMessage(error));
    } finally {
      setWardrobeLoading(false);
    }
  }, []);

  // 打开弹窗或切换账号：清掉上一次的选择，重新读一次皮肤。
  useEffect(() => {
    if (!accountId) return;
    setPicked(null);
    setLocalBroken(false);
    setConfirmReset(false);
    setInfo(null);
    setProfiles([]);
    setProfileError(null);
    void load(accountId);
  }, [accountId, load]);

  // 角色只有第三方账号才有，别的账号连问都不问。
  useEffect(() => {
    if (!accountId || !thirdParty) {
      setProfiles([]);
      setProfileError(null);
      return;
    }
    void loadProfiles(accountId);
  }, [accountId, thirdParty, loadProfiles]);

  // 衣柜是本地目录，与账号无关：弹窗打开即读一次。
  useEffect(() => {
    if (!accountId) return;
    setWardrobe(null);
    void loadWardrobe();
  }, [accountId, loadWardrobe]);

  const pick = async () => {
    setPicking(true);
    try {
      const target = await api.accounts.pickSkinFile();
      if (!target) return;
      setPicked({ path: target, url: fileUrl(target), name: fileNameOf(target), from: "file" });
      setLocalBroken(false);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setPicking(false);
    }
  };

  const selectFromWardrobe = (item: WardrobeSkin) => {
    setPicked({ path: wardrobePath(item), url: item.url, name: item.name, from: "wardrobe" });
    setLocalBroken(false);
  };

  const addToWardrobe = async () => {
    setAdding(true);
    try {
      const target = await api.accounts.pickSkinFile();
      if (!target) return;
      const name = await api.accounts.addToWardrobe(target);
      await loadWardrobe();
      push(`已添加 ${name} 到衣柜`, "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setAdding(false);
    }
  };

  const removeFromWardrobe = async () => {
    if (!toDelete) return;
    const { name } = toDelete;
    setDeleting(true);
    try {
      await api.accounts.removeFromWardrobe(name);
      setToDelete(null);
      // 删掉的正是待上传的那张：一并清掉，免得拿一个不存在的文件去上传。
      if (picked?.from === "wardrobe" && picked.name === name) setPicked(null);
      await loadWardrobe();
      push(`已从衣柜删除 ${name}`, "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setDeleting(false);
    }
  };

  const switchProfile = async (profile: SkinProfile) => {
    if (!account || profile.active || switching) return;
    setSwitching(profile.id);
    try {
      await api.accounts.selectProfile(account.id, profile.id);
      push(`已切换到角色 ${profile.name}`, "success");
      await loadProfiles(account.id);
      await load(account.id);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setSwitching(null);
    }
  };

  const apply = async () => {
    if (!account || !picked) return;
    setUploading(true);
    try {
      await api.accounts.uploadSkin(account.id, picked.path, model);
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
  const busy = picking || uploading || resetting || Boolean(switching);

  return (
    <Modal
      open={Boolean(account)}
      title="皮肤选择器"
      subtitle={account ? `账号「${account.name}」的皮肤` : undefined}
      width={640}
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

          {thirdParty && profileError ? (
            <p className="skin-error" role="alert" data-skin-profiles-error>
              角色读取失败：{profileError}
            </p>
          ) : null}

          {thirdParty && profiles.length > 1 ? (
            <section className="skin-block" data-skin-profiles>
              <header className="skin-block-head">
                <span className="skin-block-title">角色</span>
                <span className="skin-block-hint">点一个角色即可切换</span>
              </header>
              <div className="skin-profiles" role="radiogroup" aria-label="角色">
                {profiles.map((profile) => {
                  const active = profile.active;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      className={`skin-profile ${active ? "active" : ""}`.trim()}
                      onClick={() => void switchProfile(profile)}
                      disabled={active || Boolean(switching)}
                      aria-pressed={active}
                      data-skin-profile={profile.id}
                      data-skin-profile-active={active ? "1" : "0"}
                    >
                      <span
                        className="skin-avatar"
                        style={{ background: avatarColor(profile.id) }}
                        aria-hidden="true"
                        data-skin-profile-avatar
                      />
                      <span className="skin-profile-name" data-skin-profile-name>
                        {profile.name}
                      </span>
                      {active ? <span className="skin-profile-badge">使用中</span> : null}
                      {switching === profile.id ? (
                        <span className="skin-profile-busy" data-skin-profile-busy>
                          切换中…
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {thirdParty && profiles.length === 1 ? (
            <p className="skin-single-profile" data-skin-single-profile>
              当前角色：{profiles[0].name}
            </p>
          ) : null}

          <section className="skin-block" data-skin-wardrobe>
            <header className="skin-block-head">
              <span className="skin-block-title">衣柜</span>
              <span className="skin-block-hint">点一张用作待上传的皮肤</span>
              <div className="skin-block-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void addToWardrobe()}
                  disabled={blocked || adding || uploading || resetting || picking}
                  data-skin-ward-add
                >
                  <IconPlus size={14} />
                  {adding ? "添加中…" : "从文件添加到衣柜"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void loadWardrobe()}
                  disabled={wardrobeLoading}
                  data-skin-ward-refresh
                >
                  <IconRefresh size={14} />
                  {wardrobeLoading ? "读取中…" : "刷新"}
                </button>
              </div>
            </header>

            {wardrobeError ? (
              <p className="skin-error" role="alert" data-skin-ward-error>
                衣柜读取失败：{wardrobeError}
              </p>
            ) : wardrobe && wardrobe.length === 0 ? (
              <p className="skin-ward-empty" data-skin-ward-empty>
                {WARDROBE_EMPTY}
              </p>
            ) : wardrobe ? (
              <div className="skin-ward-grid" data-skin-ward-grid>
                {wardrobe.map((item) => {
                  const selected = picked?.from === "wardrobe" && picked.name === item.name;
                  return (
                    <div
                      key={item.name}
                      className={`skin-ward ${selected ? "selected" : ""}`.trim()}
                      data-skin-ward-item={item.name}
                      data-skin-ward-selected={selected ? "1" : "0"}
                    >
                      <button
                        type="button"
                        className="skin-ward-pick"
                        onClick={() => selectFromWardrobe(item)}
                        title={`${item.name} · ${formatBytes(item.sizeBytes)}`}
                        data-skin-ward-pick={item.name}
                      >
                        <img className="skin-ward-img" src={item.url} alt={item.name} data-skin-ward-img />
                        <span className="skin-ward-info">
                          <span className="skin-ward-name" data-skin-ward-name>
                            {item.name}
                          </span>
                          <span className="skin-ward-size" data-skin-ward-size>
                            {formatBytes(item.sizeBytes)}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="skin-ward-del"
                        onClick={() => setToDelete(item)}
                        aria-label={`从衣柜删除 ${item.name}`}
                        data-skin-ward-del={item.name}
                      >
                        <IconClose size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="skin-ward-empty" data-skin-ward-loading>
                读取中…
              </p>
            )}
          </section>

          <div className="skin-ops">
            <div className="skin-pick-row">
              <span className="skin-meta-label">皮肤</span>
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
                <span className="skin-file" data-skin-file-name title={picked.path} data-skin-picked-from={picked.from}>
                  {picked.from === "wardrobe" ? `衣柜 · ${picked.name}` : picked.name}
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
                    src={picked.url}
                    alt="本地皮肤预览"
                    data-skin-local-img
                    onError={() => setLocalBroken(true)}
                  />
                )}
                <span className="skin-local-hint">
                  {picked.from === "wardrobe" ? "衣柜预选（尚未上传）" : "本地预选（尚未上传）"}
                </span>
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
                disabled={blocked || !picked || uploading || resetting || picking || Boolean(switching)}
                data-skin-apply
              >
                {uploading ? "上传中…" : "应用皮肤"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-danger-ghost"
                onClick={() => setConfirmReset(true)}
                disabled={blocked || uploading || resetting || picking || Boolean(switching)}
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

          <ConfirmDialog
            open={Boolean(toDelete)}
            title="从衣柜删除"
            message={`确定把「${toDelete?.name ?? ""}」从衣柜删除吗？文件会从皮肤目录里移除。`}
            confirmText="删除"
            busyText="删除中…"
            danger
            busy={deleting}
            onCancel={() => setToDelete(null)}
            onConfirm={() => void removeFromWardrobe()}
          />
        </div>
      ) : null}
    </Modal>
  );
}
