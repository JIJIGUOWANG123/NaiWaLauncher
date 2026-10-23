import {
  useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent,
} from "react";
import type { Account, LocalSkin, SkinApplyResult } from "../../shared/types";
import { api } from "../lib/api";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { ConfirmDialog } from "../components/Modal";
import { Select } from "../components/Form";
import { EmptyState, ErrorState, SkeletonCards } from "../components/State";
import { SkinDoll, skinImageUrl, type SkinTexture } from "../components/SkinDoll";
import { IconChevronDown, IconLink, IconPlus, IconRefresh, IconTrash } from "../components/icons";

const LITTLESKIN_URL = "https://littleskin.cn/";
/** 第三方账号是只读预览：皮肤由皮肤站托管，启动器里不选中、不上传、不本地应用。 */
const READONLY_HINT = "第三方账号的皮肤由皮肤站管理，启动器只做预览";
const READONLY_NOTE = "第三方账号：只预览皮肤站上的皮肤，上传与本地应用请到皮肤站网页操作。";
const TYPE_LABEL: Record<Account["type"], string> = { offline: "离线", microsoft: "微软正版", yggdrasil: "第三方" };
const TAB_LABEL: Record<SkinTab, string> = { saved: "已保存皮肤", official: "内置皮肤" };

type SkinTab = "saved" | "official";

/** 小人当前贴图：带来源标记，页面用 data-skin-preview-source 暴露出去。 */
type PreviewTexture = SkinTexture & { source: "account" | "local" };

/** 只收 PNG：主进程按 PNG 头解析尺寸，别的格式必然打不开。 */
function isPng(file: File): boolean {
  return /\.png$/i.test(file.name);
}

/**
 * 皮肤页：本地皮肤库（内置 <root>/skins 与用户导入）+ CSS 3D 预览。
 * 皮肤与账号解耦，账号只决定「预览上显示谁的名字」和「选中的是谁的皮肤」；
 * 三种账号（离线 / 微软 / 第三方）都能在这里选皮肤并应用到实例，上传入口已从界面移除。
 */
export function SkinPage() {
  const { settings, instances, currentInstanceId } = useApp();
  const { push } = useToast();

  const accountsState = useAsync(() => api.accounts.list(), []);
  const accounts = useMemo(() => accountsState.data ?? [], [accountsState.data]);

  const [accountId, setAccountId] = useState("");
  const [skins, setSkins] = useState<LocalSkin[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SkinTab>("saved");
  const [foldOpen, setFoldOpen] = useState(true);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [applyInstanceId, setApplyInstanceId] = useState("");
  const [applying, setApplying] = useState(false);
  const [ensuring, setEnsuring] = useState(false);
  const [applyResult, setApplyResult] = useState<SkinApplyResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 默认账号：设置里选中的那个，没有就取第一个；页面上仍可切换。
  useEffect(() => {
    if (accountId) return;
    const preferred = settings?.activeAccountId ?? "";
    const fallback = accounts.find((item) => item.id === preferred)?.id ?? accounts[0]?.id ?? "";
    if (fallback) setAccountId(fallback);
  }, [accounts, accountId, settings?.activeAccountId]);

  // 目标实例默认取当前实例，其次第一个实例。
  useEffect(() => {
    if (applyInstanceId) return;
    const preferred = currentInstanceId ?? "";
    const fallback = instances.find((item) => item.id === preferred)?.id ?? instances[0]?.id ?? "";
    if (fallback) setApplyInstanceId(fallback);
  }, [applyInstanceId, currentInstanceId, instances]);

  const account = useMemo(
    () => accounts.find((item) => item.id === accountId) ?? null,
    [accountId, accounts],
  );

  const load = useCallback(async () => {
    if (!accountId) {
      setSkins([]);
      return;
    }
    setLoading(true);
    try {
      setSkins(await api.skinsLocal.list(accountId));
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const accountOptions = useMemo(
    () => accounts.map((item) => ({ value: item.id, label: `${item.name}（${TYPE_LABEL[item.type]}）` })),
    [accounts],
  );
  const instanceOptions = useMemo(
    () => instances.map((item) => ({ value: item.id, label: item.name })),
    [instances],
  );

  const userSkins = useMemo(() => (skins ?? []).filter((item) => item.source === "user"), [skins]);
  const officialSkins = useMemo(() => (skins ?? []).filter((item) => item.source === "official"), [skins]);
  const listSkins = tab === "saved" ? userSkins : officialSkins;

  // 第三方账号只读：整页退化成「预览皮肤站上的那张皮肤」。
  const readonly = account?.type === "yggdrasil";
  // 账号当前皮肤（微软走 profile.skins、第三方走皮肤站 profile 接口、离线一般没有）。
  const accountSkin = useAsync(
    () => (account ? api.accounts.skin(account.id) : Promise.resolve(null)),
    [account?.id],
  );
  const accountTexture = useMemo<PreviewTexture | null>(() => {
    const info = accountSkin.data;
    if (!info?.skinUrl) return null;
    return { url: info.skinUrl, model: info.model ?? "classic", height: 64, label: "account", source: "account" };
  }, [accountSkin.data]);

  /**
   * 小人贴图来源：
   * - 第三方账号：只认皮肤站上的那张（没有就空态，不回退本地皮肤）
   * - 离线 / 微软：优先选中的本地皮肤 → 账号当前皮肤 → 库里的第一张，别留空白
   */
  const previewTexture = useMemo<PreviewTexture | null>(() => {
    if (readonly) return accountTexture;
    const list = skins ?? [];
    const chosen = list.find((item) => item.active) ?? null;
    if (chosen) {
      return { url: skinImageUrl(chosen.path), model: chosen.model, height: chosen.height, label: chosen.fileName, source: "local" };
    }
    if (accountTexture) return accountTexture;
    const fallback = list[0] ?? null;
    return fallback
      ? { url: skinImageUrl(fallback.path), model: fallback.model, height: fallback.height, label: fallback.fileName, source: "local" }
      : null;
  }, [accountTexture, readonly, skins]);

  /** 拖放与「添加皮肤」卡片共用这一条导入链路（都走 skinsLocal.import）。 */
  const importFiles = async (files: File[]) => {
    // 导入的皮肤属于「已保存皮肤」：在内置 tab 里拖放时，导入完自动切过去，否则用户看不到结果
    if (tab !== "saved") setTab("saved");
    if (readonly) {
      push(READONLY_HINT, "info");
      return;
    }
    if (files.length === 0) return;
    const pngs = files.filter(isPng);
    if (pngs.length === 0) {
      push("只支持 PNG 皮肤文件", "error");
      return;
    }
    if (pngs.length !== files.length) push("已跳过非 PNG 文件", "info");
    setImporting(true);
    try {
      // 渲染层拿不到 File 的真实路径，必须经主进程的 webUtils 换一次。
      const paths = pngs.map((file) => api.skinsLocal.pathForFile(file));
      const result = await api.skinsLocal.import(paths);
      if (result.imported.length > 0) {
        push(`已导入 ${result.imported.length} 张皮肤`, "success");
        setTab("saved");
      } else {
        push("没有新的皮肤可导入", "info");
      }
      if (result.skipped.length > 0) push(`已跳过：${result.skipped.join("、")}`, "info");
      await load();
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setImporting(false);
    }
  };

  const onPickFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    // 清空 value，否则同一个文件选第二次不会触发 change。
    event.target.value = "";
    await importFiles(picked);
  };

  const onDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    await importFiles(Array.from(event.dataTransfer?.files ?? []));
  };

  const selectSkin = async (fileName: string) => {
    if (!accountId) {
      push("先在右上角选一个账号，再挑皮肤", "info");
      return;
    }
    // 第三方账号的皮肤只能由皮肤站决定，这里不调 select，只给一句可读提示。
    if (readonly) {
      push(READONLY_HINT, "info");
      return;
    }
    setBusyFile(fileName);
    try {
      setSkins(await api.skinsLocal.select(accountId, fileName));
      push("已选中这张皮肤", "success");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setBusyFile(null);
    }
  };

  // 删除是破坏性操作：先弹确认，避免手滑把导入的皮肤删掉（内置皮肤本来就不给删）。
  const [toDelete, setToDelete] = useState<string | null>(null);
  const removeSkin = async (fileName: string) => {
    setToDelete(null);
    setBusyFile(fileName);
    try {
      setSkins(await api.skinsLocal.remove(fileName));
      push(`已删除 ${fileName}`, "success");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setBusyFile(null);
    }
  };

  const applyToInstance = async () => {
    if (readonly) {
      push("第三方账号不需要本地应用：进游戏时会自动从皮肤站加载", "info");
      return;
    }
    if (!accountId) {
      push("先在右上角选一个账号，再应用到实例", "info");
      return;
    }
    if (!applyInstanceId) {
      push("先在上面选一个目标实例", "info");
      return;
    }
    setApplying(true);
    try {
      const result = await api.skinsLocal.applyToInstance(applyInstanceId, accountId);
      setApplyResult(result);
      push(result.message ?? (result.applied ? "皮肤已应用" : "没有应用皮肤"), result.applied ? "success" : "error");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setApplying(false);
    }
  };

  const ensureMod = async () => {
    if (!applyInstanceId) return;
    setEnsuring(true);
    try {
      const result = await api.skinsLocal.ensureMod(applyInstanceId);
      push(result.installed
        ? `已安装 ${result.fileName ?? "CustomSkinLoader"}，再点一次「应用到实例」即可生效`
        : (result.message ?? "安装失败，请到「资源」页手动安装 CustomSkinLoader"), result.installed ? "success" : "error");
      if (result.installed) setApplyResult((prev) => (prev ? { ...prev, modInstalled: true } : prev));
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setEnsuring(false);
    }
  };

  const openLittleSkin = async () => {
    try {
      await api.app.openExternal(LITTLESKIN_URL);
      push("已用外部浏览器打开 LittleSkin", "success");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    }
  };

  const renderCard = (skin: LocalSkin) => (
    <div
      key={skin.fileName}
      className={`skin-card ${skin.active ? "is-active" : ""} ${readonly ? "is-locked" : ""}`.trim()}
      data-skin-card={skin.fileName}
      data-skin-source={skin.source}
      data-skin-locked={readonly ? "true" : undefined}
    >
      <button
        type="button"
        className="skin-card-main"
        data-action="select-skin"
        // 第三方账号只读：点击只提示原因，绝不再调 select（见下方 onClick 的 early return）。
        onClick={() => {
          if (readonly) {
            push(READONLY_HINT, "info");
            return;
          }
          void selectSkin(skin.fileName);
        }}
        // 只读模式用 aria-disabled（而不是原生 disabled）：「点一下给一句原因」比死按钮更好用。
        disabled={busyFile === skin.fileName}
        aria-disabled={readonly || undefined}
        title={readonly
          ? READONLY_HINT
          : `${skin.fileName} · ${skin.width}×${skin.height} · ${skin.model === "slim" ? "细臂" : "标准臂"}`}
      >
        <img className="skin-thumb" src={skinImageUrl(skin.path)} alt="" width={56} height={56} />
        <span className="skin-card-name">{skin.name}</span>
        <span className="skin-card-meta">{skin.model === "slim" ? "细臂" : "标准臂"} · {skin.width}×{skin.height}</span>
      </button>
      {skin.active ? <span className="badge skin-active-tag">使用中</span> : null}
      {skin.source === "user" ? (
        <button
          type="button"
          className="skin-card-del"
          data-action="delete-skin"
          onClick={() => setToDelete(skin.fileName)}
          disabled={busyFile === skin.fileName}
          title="从本地皮肤库删除"
        >
          <IconTrash size={14} />
          删除
        </button>
      ) : null}
    </div>
  );

  return (
    <section
      className={`page skin-page ${dragging ? "is-dragging" : ""}`}
      data-skin-page
      // 整页都能接住拖进来的 PNG：拖到卡片、网格或空白处都一样；第三方账号只读模式下不收拖放。
      onDragOver={(event) => {
        if (readonly) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => void onDrop(event)}
    >
      <header className="page-head">
        <div>
          <h1 className="page-title">皮肤</h1>
          <p className="page-sub">本地皮肤库：内置皮肤（启动器根目录的 skins）+ 自己导入的 PNG，离线、微软与第三方账号都能选。</p>
        </div>
        <div className="page-actions">
          <Select
            value={accountId}
            options={accountOptions}
            onChange={setAccountId}
            ariaLabel="预览账号"
            placeholder={accountsState.loading ? "读取账号…" : "还没有账号"}
            disabled={accounts.length === 0}
          />
          <button type="button" className="btn btn-ghost" onClick={() => void load()} disabled={loading || !accountId}>
            <IconRefresh size={16} />
            刷新
          </button>
        </div>
      </header>

      {readonly ? (
        <div className="skin-readonly" data-skin-readonly={account?.type} role="status">
          <span>{READONLY_NOTE}</span>
          <button
            type="button"
            className="account-link"
            data-action="open-littleskin"
            onClick={() => void openLittleSkin()}
          >
            <IconLink size={14} />
            去皮肤站网页
          </button>
        </div>
      ) : null}

      <div className="skin-toolbar">
        <Select
          value={applyInstanceId}
          options={instanceOptions}
          onChange={setApplyInstanceId}
          ariaLabel="目标实例"
          placeholder={instances.length === 0 ? "还没有实例" : "选择实例"}
        />
        <button
          type="button"
          className="btn btn-primary"
          data-action="apply-skin"
          onClick={() => void applyToInstance()}
          disabled={readonly || applying || !applyInstanceId || !accountId}
          title={readonly ? "第三方账号不需要本地应用：进游戏时会自动从皮肤站加载" : undefined}
        >
          {applying ? "应用中…" : "应用到实例"}
        </button>
        <p className="skin-toolbar-hint">
          {readonly
            ? "第三方账号的皮肤由皮肤站下发，不需要写进实例。"
            : "把选中的皮肤写进实例的 CustomSkinLoader 本地皮肤目录，游戏里只看得到自己。"}
        </p>
      </div>

      {applyResult ? (
        <div className={`skin-apply-hint ${applyResult.modInstalled ? "is-ok" : "is-warn"}`} data-skin-apply-hint>
          <span>{applyResult.message ?? (applyResult.applied ? "皮肤已写入实例" : "皮肤没有写入实例")}</span>
          {applyResult.modInstalled ? null : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-action="ensure-skin-mod"
              onClick={() => void ensureMod()}
              disabled={ensuring || !applyInstanceId}
            >
              {ensuring ? "安装中…" : "一键安装 CustomSkinLoader"}
            </button>
          )}
        </div>
      ) : null}

      <div className="skin-layout">
        <section className="panel skin-stage" data-skin-preview-source={previewTexture?.source ?? "none"}>
          <span className="skin-name" data-skin-name>{account?.name ?? "未选择账号"}</span>
          <SkinDoll texture={previewTexture} emptyHint="该账号还没有可预览的皮肤" />
          <p className="skin-rotate-hint" data-skin-hint>拖动以旋转</p>
          {readonly ? (
            <p className="skin-account-hint" data-skin-account-hint>
              {accountSkin.loading
                ? "正在读取皮肤站上的皮肤…"
                : previewTexture
                  ? "贴图来自皮肤站，换皮肤请到皮肤站网页操作。"
                  : `该账号在皮肤站还没有设置皮肤（${accountSkin.error ?? "接口没有返回皮肤"}），可到皮肤站网页上传。`}
            </p>
          ) : null}
        </section>

        <section className={`panel skin-library ${dragging ? "is-dragging" : ""}`} data-skin-library>
          <div className="segmented skin-tabs" role="tablist" aria-label="皮肤列表">
            {(["saved", "official"] as SkinTab[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={`segmented-item ${tab === key ? "active" : ""}`.trim()}
                data-skin-tab={key}
                onClick={() => setTab(key)}
              >
                {TAB_LABEL[key]} {key === "saved" ? userSkins.length : officialSkins.length}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="skin-fold"
            data-skin-fold={tab}
            aria-expanded={foldOpen}
            onClick={() => setFoldOpen((value) => !value)}
          >
            <span className="field-label">{TAB_LABEL[tab]}</span>
            <span className="panel-count">{listSkins.length} 张{tab === "official" ? " · 内置只读" : ""}</span>
            <IconChevronDown size={15} className={`skin-fold-icon ${foldOpen ? "is-open" : ""}`.trim()} />
          </button>

          {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
          {!error && loading && skins === null ? <SkeletonCards count={2} /> : null}

          {foldOpen && !error ? (
            <>
              {skins !== null && listSkins.length === 0 ? (
                <EmptyState
                  title={tab === "saved" ? "还没有保存的皮肤" : "没有内置皮肤"}
                  hint={tab === "saved"
                    ? "把 64×64（或 64×32）的 PNG 拖进这里，或点下面的「添加皮肤」。"
                    : "内置皮肤随程序一起分发、只读，用户在本地无法添加或修改。若这里为空，说明安装包缺少内嵌皮肤资源，重装启动器即可恢复。"}
                />
              ) : null}
              <div className="skin-grid" data-skin-grid>
                {listSkins.map(renderCard)}
                {/* 「添加皮肤」只属于用户自己的皮肤库：内置皮肤内嵌在程序里，用户既找不到也不该改它 */}
                {readonly || tab !== "saved" ? null : (
                  <button
                    type="button"
                    className="skin-add"
                    data-skin-add
                    onClick={() => fileInputRef.current?.click()}
                    disabled={importing}
                  >
                    <IconPlus size={18} />
                    <span>{importing ? "导入中…" : "添加皮肤"}</span>
                    <span className="skin-add-hint">点击选择或把 PNG 拖到这里</span>
                  </button>
                )}
              </div>
            </>
          ) : null}
        </section>
      </div>

      <footer className="skin-recommend">
        <span>想让自己皮肤对别人也可见，可在 LittleSkin 上传：</span>
        <button type="button" className="account-link" data-action="open-littleskin" onClick={() => void openLittleSkin()}>
          <IconLink size={14} />
          {LITTLESKIN_URL}
        </button>
      </footer>

      <input ref={fileInputRef} type="file" accept="image/png" multiple hidden onChange={(event) => void onPickFiles(event)} />
      <ConfirmDialog
        open={toDelete !== null}
        title="删除本地皮肤"
        message={toDelete ? `确定删除 ${toDelete} 吗？该文件会从本地皮肤库移除。` : ""}
        confirmText="删除"
        danger
        busy={busyFile !== null}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) void removeSkin(toDelete);
        }}
      />
    </section>
  );
}