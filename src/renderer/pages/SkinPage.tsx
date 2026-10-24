import {
  useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent,
} from "react";
import type { Account, LocalCape, LocalSkin, SkinApplyResult } from "../../shared/types";
import type { MojangCapeEntry, MojangProfile, MojangVariant } from "../../shared/ipc";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { ConfirmDialog } from "../components/Modal";
import { Select, TextInput } from "../components/Form";
import { EmptyState, ErrorState, SkeletonCards } from "../components/State";
import { SkinDoll, skinImageUrl, type CapeTexture, type SkinTexture } from "../components/SkinDoll";
import { IconCheck, IconChevronDown, IconLink, IconPlus, IconRefresh, IconTrash } from "../components/icons";

const LITTLESKIN_URL = "https://littleskin.cn/";
/** 第三方账号是只读预览：皮肤由皮肤站托管，启动器里不选中、不上传、不本地应用。 */
const READONLY_HINT_KEY = "pages.skin.readonlyHint";
const READONLY_NOTE_KEY = "pages.skin.readonlyNote";
const MCSTAT_URL = "https://mcstat.org/zh-Hans/skins/capes";
/**
 * 披风贴图规则（与主进程一致）：64×32、22×17，或 64×32 的整数倍放大图（如 1024×512），
 * 放大图导入时由主进程自动缩放到 64×32。
 */
const CAPE_RULE_KEY = "pages.skin.capeRule";
/** 披风只读说明：微软走 Mojang 官网，第三方走皮肤站。 */
const CAPE_READONLY_HINT_KEY: Record<"microsoft" | "yggdrasil", string> = {
  microsoft: "pages.skin.capeReadonlyMicrosoft",
  yggdrasil: "pages.skin.capeReadonlyYggdrasil",
};
const TYPE_LABEL_KEY: Record<Account["type"], string> = {
  offline: "pages.skin.typeOffline",
  microsoft: "pages.skin.typeMicrosoft",
  yggdrasil: "pages.skin.typeYggdrasil",
};
const TAB_LABEL_KEY: Record<SkinTab, string> = { saved: "pages.skin.tabSaved", official: "pages.skin.tabOfficial" };

type SkinTab = "saved" | "official";

/** 披风分段：与皮肤同款两段（已保存 = 用户导入，内置 = 随程序分发）。 */
type CapeTab = "saved" | "official";

const CAPE_TAB_LABEL_KEY: Record<CapeTab, string> = { saved: "pages.skin.capeTabSaved", official: "pages.skin.capeTabOfficial" };

/** 小人当前贴图：带来源标记，页面用 data-skin-preview-source 暴露出来。 */
type PreviewTexture = SkinTexture & { source: "account" | "local" };

/** 只收 PNG：主进程按 PNG 头解析尺寸，别的格式必然打不开。 */
function isPng(file: File): boolean {
  return /\.png$/i.test(file.name);
}

/** 官方档案里的当前皮肤：优先 state=ACTIVE，拿不到就退回第一张（与主进程的取法一致）。 */
function activeMojangSkin(profile: MojangProfile | null) {
  if (!profile) return null;
  return profile.skins.find((item) => item.state === "ACTIVE") ?? profile.skins[0] ?? null;
}

/** 官方档案里的当前披风：同样优先 state=ACTIVE。 */
function activeMojangCape(capes: MojangCapeEntry[]) {
  return capes.find((item) => item.state === "ACTIVE") ?? null;
}

/** 披风显示名：Mojang 只给部分披风 alias，没有就退回 id 前 8 位。 */
function capeLabel(cape: MojangCapeEntry): string {
  return cape.alias ?? cape.id;
}

/**
 * 皮肤页：本地皮肤库（内置 <root>/skins 与用户导入）+ CSS 3D 预览。
 * 皮肤与账号解耦，账号只决定「预览上显示谁的名字」和「选中的是谁的皮肤」；
 * 三种账号（离线 / 微软 / 第三方）都能在这里选皮肤并应用到实例，上传入口已从界面移除。
 */
export function SkinPage() {
  const { settings, instances, currentInstanceId } = useApp();
  const { push } = useToast();
  const tr = useT();
  const modelLabel = (model: string) => (model === "slim" ? tr("pages.skin.modelSlim") : tr("pages.skin.modelClassic"));

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

  // 披风：离线账号可选本地披风，微软/第三方只读预览账号自带的披风。
  const [capes, setCapes] = useState<LocalCape[] | null>(null);
  const [capeBusy, setCapeBusy] = useState<string | null>(null);
  const [capeImporting, setCapeImporting] = useState(false);
  const [capeToDelete, setCapeToDelete] = useState<string | null>(null);
  const [capeTab, setCapeTab] = useState<CapeTab>("saved");
  const capeInputRef = useRef<HTMLInputElement | null>(null);

  // 微软正版：官方档案（皮肤 + 披风）直接来自 Mojang 接口，上传/换披风都落到账号上。
  const [mojangProfile, setMojangProfile] = useState<MojangProfile | null>(null);
  const [mojangLoading, setMojangLoading] = useState(false);
  const [mojangVariant, setMojangVariant] = useState<MojangVariant>("classic");
  const [mojangUrl, setMojangUrl] = useState("");
  /** 正在进行的操作：upload / url / reload / refresh。 */
  const [mojangBusy, setMojangBusy] = useState<"" | "upload" | "url" | "refresh">("");
  /** 正在切换的披风 id（null = 没有披风操作在跑）。 */
  const [mojangCapeBusy, setMojangCapeBusy] = useState<string | null>(null);
  /** 当前披风缩略图加载失败 → 换成占位块。 */
  const [mojangCapeBroken, setMojangCapeBroken] = useState(false);
  /** 列表里缩略图加载失败的披风 id（贴图 CDN 偶尔 404，失败给占位而不是破图）。 */
  const [mojangCapeBrokenIds, setMojangCapeBrokenIds] = useState<string[]>([]);

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

  /** 当前选中的账号是不是微软正版：只有它才有官方皮肤/披风接口。 */
  const microsoftAccount = account?.type === "microsoft" ? account : null;

  /** 读官方档案；失败只 toast（profile.error 也已经带可读文案），不弹阻塞框。 */
  const loadMojang = useCallback(async (id: string) => {
    if (!id) {
      setMojangProfile(null);
      return;
    }
    setMojangLoading(true);
    try {
      const profile = await api.mojang.profile(id);
      setMojangProfile(profile);
      // 披风贴图换了，之前的「加载失败」标记要一起清掉
      setMojangCapeBroken(false);
      setMojangCapeBrokenIds([]);
      const active = activeMojangSkin(profile);
      if (active) setMojangVariant(active.variant);
      if (profile?.error) push(tr("pages.skins.loadFailed", { error: profile.error }), "error");
    } catch (err: unknown) {
      setMojangProfile(null);
      push(errorMessage(err), "error");
    } finally {
      setMojangLoading(false);
    }
  }, [push, tr]);

  useEffect(() => {
    setMojangProfile(null);
    if (microsoftAccount) void loadMojang(microsoftAccount.id);
  }, [loadMojang, microsoftAccount?.id]);

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
    () => accounts.map((item) => ({ value: item.id, label: `${item.name}（${tr(TYPE_LABEL_KEY[item.type])}）` })),
    [accounts, tr],
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

  /** 只有离线账号能碰本地披风库；微软/第三方一律只读（只看账号自带披风）。 */
  const capeEditable = account?.type === "offline";
  const capeReadonlyType = account?.type === "microsoft" || account?.type === "yggdrasil"
    ? account.type
    : null;

  const loadCapes = useCallback(async () => {
    // 只读账号也要拿到列表（卡片灰化展示），只是不能选。
    if (!accountId) {
      setCapes([]);
      return;
    }
    try {
      setCapes(await api.capes.list(accountId));
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    }
  }, [accountId, push]);

  useEffect(() => {
    void loadCapes();
  }, [loadCapes]);

  const userCapes = useMemo(() => (capes ?? []).filter((item) => item.source === "user"), [capes]);
  const officialCapes = useMemo(() => (capes ?? []).filter((item) => item.source === "official"), [capes]);
  const listCapes = capeTab === "saved" ? userCapes : officialCapes;

  /**
   * 当前预览的披风：离线优先用本地选中的那张（内置或用户导入都算），其次账号自带（一般没有）；
   * 微软/第三方只认 SkinInfo.capeUrl。
   */
  const previewCape = useMemo<CapeTexture | null>(() => {
    const list = capes ?? [];
    if (capeEditable) {
      const chosen = list.find((item) => item.active) ?? null; // 内置与用户披风都可能是 active
      if (chosen) return { url: skinImageUrl(chosen.path), source: "local", label: chosen.fileName };
    }
    const capeUrl = accountSkin.data?.capeUrl;
    return capeUrl ? { url: capeUrl, source: "account", label: "account" } : null;
  }, [accountSkin.data, capeEditable, capes]);

  /** 拖放与「添加皮肤」卡片共用这一条导入链路（都走 skinsLocal.import）。 */
  const importFiles = async (files: File[]) => {
    // 导入的皮肤属于「已保存皮肤」：在内置 tab 里拖放时，导入完自动切过去，否则用户看不到结果
    if (tab !== "saved") setTab("saved");
    if (readonly) {
      push(tr(READONLY_HINT_KEY), "info");
      return;
    }
    if (files.length === 0) return;
    const pngs = files.filter(isPng);
    if (pngs.length === 0) {
      push(tr("pages.skin.errPngOnly"), "error");
      return;
    }
    if (pngs.length !== files.length) push(tr("pages.skin.skippedNonPng"), "info");
    setImporting(true);
    try {
      // 渲染层拿不到 File 的真实路径，必须经主进程的 webUtils 换一次。
      const paths = pngs.map((file) => api.skinsLocal.pathForFile(file));
      const result = await api.skinsLocal.import(paths);
      if (result.imported.length > 0) {
        push(tr("pages.skin.importedSkins", { count: result.imported.length }), "success");
        setTab("saved");
      } else {
        push(tr("pages.skin.noNewSkins"), "info");
      }
      if (result.skipped.length > 0) push(tr("pages.skin.skippedFiles", { files: result.skipped.join(", ") }), "info");
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
      push(tr("pages.skin.selectAccountFirst"), "info");
      return;
    }
    // 第三方账号的皮肤只能由皮肤站决定，这里不调 select，只给一句可读提示。
    if (readonly) {
      push(tr(READONLY_HINT_KEY), "info");
      return;
    }
    setBusyFile(fileName);
    try {
      setSkins(await api.skinsLocal.select(accountId, fileName));
      push(tr("pages.skin.skinSelected"), "success");
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
      push(tr("pages.skin.deletedName", { name: fileName }), "success");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setBusyFile(null);
    }
  };

  /** 披风导入：和皮肤同一条 webUtils 通道，但落到 capes.import。 */
  const importCapeFiles = async (files: File[]) => {
    if (!capeEditable) {
      push(tr("pages.skin.capeOfflineOnly"), "info");
      return;
    }
    const pngs = files.filter(isPng);
    if (pngs.length === 0) {
      push(tr("pages.skin.errCapePngOnly"), "error");
      return;
    }
    setCapeImporting(true);
    try {
      const paths = pngs.map((file) => api.capes.pathForFile(file));
      const result = await api.capes.import(paths);
      if (result.imported.length > 0) push(tr("pages.skin.importedCapes", { count: result.imported.length }), "success");
      // 契约里 skipped 只有文件名（没有失败原因），所以把尺寸规则原样贴出来，不自己编原因。
      if (result.skipped.length > 0) {
        push(tr("pages.skin.capeSkipped", { rule: tr(CAPE_RULE_KEY), files: result.skipped.join(", ") }), "error");
      } else if (result.imported.length === 0) {
        push(tr("pages.skin.noNewCapes"), "info");
      }
      await loadCapes();
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setCapeImporting(false);
    }
  };

  const onPickCapeFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    await importCapeFiles(picked);
  };

  const selectCape = async (fileName: string) => {
    if (!accountId || !capeEditable) {
      push(tr("pages.skin.capeSelectOfflineOnly"), "info");
      return;
    }
    setCapeBusy(fileName);
    try {
      setCapes(await api.capes.select(accountId, fileName));
      push(tr("pages.skin.capeSelected"), "success");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setCapeBusy(null);
    }
  };

  // 删除披风也是破坏性操作：先二次确认再调 capes.remove。
  const removeCape = async (fileName: string) => {
    setCapeToDelete(null);
    setCapeBusy(fileName);
    try {
      setCapes(await api.capes.remove(fileName));
      push(tr("pages.skin.deletedName", { name: fileName }), "success");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setCapeBusy(null);
    }
  };

  const applyToInstance = async () => {
    if (readonly) {
      push(tr("pages.skin.noLocalApply"), "info");
      return;
    }
    if (!accountId) {
      push(tr("pages.skin.selectAccountForApply"), "info");
      return;
    }
    if (!applyInstanceId) {
      push(tr("pages.skin.selectInstanceFirst"), "info");
      return;
    }
    setApplying(true);
    try {
      const result = await api.skinsLocal.applyToInstance(applyInstanceId, accountId);
      setApplyResult(result);
      push(
        result.message ?? tr(result.applied ? "pages.skin.skinApplied" : "pages.skin.skinNotApplied"),
        result.applied ? "success" : "error",
      );
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
      push(
        result.installed
          ? tr("pages.skin.cslInstalled", { name: result.fileName ?? "CustomSkinLoader" })
          : (result.message ?? tr("pages.skin.cslInstallFailed")),
        result.installed ? "success" : "error",
      );
      if (result.installed) setApplyResult((prev) => (prev ? { ...prev, modInstalled: true } : prev));
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setEnsuring(false);
    }
  };

  /** LittleSkin / mcstat 都走主进程 openExternal，避免渲染层直接开网页。 */
  const openSite = async (url: string, label: string) => {
    try {
      await api.app.openExternal(url);
      push(tr("pages.skin.openedExternal", { label }), "success");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    }
  };

  const openLittleSkin = () => openSite(LITTLESKIN_URL, "LittleSkin");
  const openMcstat = () => openSite(MCSTAT_URL, "mcstat");

  // ---------------------------------------------------------------- 微软正版：官方皮肤与披风

  const mojangCapes = useMemo<MojangCapeEntry[]>(() => mojangProfile?.capes ?? [], [mojangProfile]);
  const mojangActiveCape = useMemo(() => activeMojangCape(mojangCapes), [mojangCapes]);
  /** 官方当前皮肤 → 复用页面既有的 CSS 3D 小人（SkinDoll）。 */
  const mojangTexture = useMemo<SkinTexture | null>(() => {
    const skin = activeMojangSkin(mojangProfile);
    return skin ? { url: skin.url, model: skin.variant, height: 64, label: "mojang" } : null;
  }, [mojangProfile]);
  const mojangCapeTexture = useMemo<CapeTexture | null>(
    () => (mojangActiveCape
      ? { url: mojangActiveCape.url, source: "account", label: capeLabel(mojangActiveCape) }
      : null),
    [mojangActiveCape],
  );
  const mojangActiveSkin = useMemo(() => activeMojangSkin(mojangProfile), [mojangProfile]);
  const mojangLocked = microsoftAccount === null;

  /** 选本地 PNG（走主进程的文件框）→ 按所选模型上传到 Mojang。 */
  const uploadMojangFromFile = async () => {
    if (!microsoftAccount) {
      push(tr("pages.skins.lockedHint"), "info");
      return;
    }
    let filePath: string | null = null;
    try {
      filePath = await api.accounts.pickSkinFile();
    } catch (err: unknown) {
      push(errorMessage(err), "error");
      return;
    }
    // 取消选择不是错误，什么也不做
    if (!filePath) return;
    setMojangBusy("upload");
    try {
      const result = await api.mojang.upload({ accountId: microsoftAccount.id, filePath, variant: mojangVariant });
      if (!result.ok) {
        push(tr("pages.skins.uploadFailed", { error: result.error ?? "" }), "error");
        return;
      }
      push(tr("pages.skins.uploadOk"), "success");
      await loadMojang(microsoftAccount.id);
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setMojangBusy("");
    }
  };

  /** 用图片直链设置（官方 JSON 方式）。 */
  const uploadMojangFromUrl = async () => {
    if (!microsoftAccount) {
      push(tr("pages.skins.lockedHint"), "info");
      return;
    }
    const url = mojangUrl.trim();
    if (!url) {
      push(tr("pages.skins.urlLabel"), "info");
      return;
    }
    setMojangBusy("url");
    try {
      const result = await api.mojang.upload({ accountId: microsoftAccount.id, url, variant: mojangVariant });
      if (!result.ok) {
        push(tr("pages.skins.uploadFailed", { error: result.error ?? "" }), "error");
        return;
      }
      push(tr("pages.skins.urlOk"), "success");
      setMojangUrl("");
      await loadMojang(microsoftAccount.id);
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setMojangBusy("");
    }
  };

  /** 刷新披风列表（GET /minecraft/profile/capes）：只替换披风，皮肤预览保持不动。 */
  const refreshMojangCapes = async () => {
    if (!microsoftAccount) {
      push(tr("pages.skins.lockedHint"), "info");
      return;
    }
    setMojangBusy("refresh");
    try {
      const list = await api.mojang.capes(microsoftAccount.id);
      setMojangProfile((prev) => (prev ? { ...prev, capes: list } : prev));
      push(tr("pages.skins.refreshed"), "success");
    } catch (err: unknown) {
      push(tr("pages.skins.capeFailed", { error: errorMessage(err) }), "error");
    } finally {
      setMojangBusy("");
    }
  };

  /** 应用/移除披风：成功后重读档案，让「使用中」高亮跟着官方状态走。 */
  const applyMojangCape = async (capeId: string | null) => {
    if (!microsoftAccount) return;
    const target = capeId === null ? null : mojangCapes.find((item) => item.id === capeId) ?? null;
    setMojangCapeBusy(capeId ?? "__remove__");
    try {
      const result = await api.mojang.setCape({ accountId: microsoftAccount.id, capeId });
      if (!result.ok) {
        push(tr("pages.skins.capeFailed", { error: result.error ?? "" }), "error");
        return;
      }
      push(
        capeId === null
          ? tr("pages.skins.capeRemoved")
          : tr("pages.skins.capeApplied", { name: target ? capeLabel(target) : capeId }),
        "success",
      );
      await loadMojang(microsoftAccount.id);
    } catch (err: unknown) {
      push(tr("pages.skins.capeFailed", { error: errorMessage(err) }), "error");
    } finally {
      setMojangCapeBusy(null);
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
            push(tr(READONLY_HINT_KEY), "info");
            return;
          }
          void selectSkin(skin.fileName);
        }}
        // 只读模式用 aria-disabled（而不是原生 disabled）：「点一下给一句原因」比死按钮更好用。
        disabled={busyFile === skin.fileName}
        aria-disabled={readonly || undefined}
        title={readonly
          ? tr(READONLY_HINT_KEY)
          : `${skin.fileName} · ${skin.width}×${skin.height} · ${modelLabel(skin.model)}`}
      >
        <img className="skin-thumb" src={skinImageUrl(skin.path)} alt="" width={56} height={56} />
        <span className="skin-card-name">{skin.name}</span>
        <span className="skin-card-meta">{modelLabel(skin.model)} · {skin.width}×{skin.height}</span>
      </button>
      {skin.active ? <span className="badge skin-active-tag">{tr("pages.skin.inUse")}</span> : null}
      {skin.source === "user" ? (
        <button
          type="button"
          className="skin-card-del"
          data-action="delete-skin"
          onClick={() => setToDelete(skin.fileName)}
          disabled={busyFile === skin.fileName}
          title={tr("pages.skin.deleteFromLibrary")}
        >
          <IconTrash size={14} />
          {tr("pages.common.delete")}
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
          <h1 className="page-title">{tr("pages.skin.pageTitle")}</h1>
          <p className="page-sub">{tr("pages.skin.pageSub")}</p>
        </div>
        <div className="page-actions">
          <Select
            value={accountId}
            options={accountOptions}
            onChange={setAccountId}
            ariaLabel={tr("pages.skin.previewAccount")}
            placeholder={accountsState.loading ? tr("pages.skin.readingAccounts") : tr("pages.skin.noAccounts")}
            disabled={accounts.length === 0}
          />
          <button type="button" className="btn btn-ghost" onClick={() => void load()} disabled={loading || !accountId}>
            <IconRefresh size={16} />
            {tr("pages.common.refresh")}
          </button>
        </div>
      </header>

      {readonly ? (
        <div className="skin-readonly" data-skin-readonly={account?.type} role="status">
          <span>{tr(READONLY_NOTE_KEY)}</span>
          <button
            type="button"
            className="account-link"
            data-action="open-littleskin"
            onClick={() => void openLittleSkin()}
          >
            <IconLink size={14} />
            {tr("pages.skin.openSkinSite")}
          </button>
        </div>
      ) : null}

      <div className="skin-toolbar">
        <Select
          value={applyInstanceId}
          options={instanceOptions}
          onChange={setApplyInstanceId}
          ariaLabel={tr("pages.skin.targetInstance")}
          placeholder={instances.length === 0 ? tr("pages.skin.noInstances") : tr("pages.skin.pickInstance")}
        />
        <button
          type="button"
          className="btn btn-primary"
          data-action="apply-skin"
          onClick={() => void applyToInstance()}
          disabled={readonly || applying || !applyInstanceId || !accountId}
          title={readonly ? tr("pages.skin.noLocalApply") : undefined}
        >
          {applying ? tr("pages.skin.applying") : tr("pages.skin.applyToInstance")}
        </button>
        <p className="skin-toolbar-hint">
          {readonly ? tr("pages.skin.readonlyApplyHint") : tr("pages.skin.applyHint")}
        </p>
      </div>

      {applyResult ? (
        <div className={`skin-apply-hint ${applyResult.modInstalled ? "is-ok" : "is-warn"}`} data-skin-apply-hint>
          <span>
            {applyResult.message ??
              tr(applyResult.applied ? "pages.skin.skinWritten" : "pages.skin.skinNotWritten")}
          </span>
          {applyResult.modInstalled ? null : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-action="ensure-skin-mod"
              onClick={() => void ensureMod()}
              disabled={ensuring || !applyInstanceId}
            >
              {ensuring ? tr("pages.skin.installingMod") : tr("pages.skin.installCsl")}
            </button>
          )}
        </div>
      ) : null}

      <div className="skin-layout">
        <section className="panel skin-stage" data-skin-preview-source={previewTexture?.source ?? "none"}>
          <span className="skin-name" data-skin-name>{account?.name ?? tr("pages.skin.noAccountSelected")}</span>
          <SkinDoll texture={previewTexture} cape={previewCape} emptyHint={tr("pages.skin.noPreviewSkin")} />
          <p className="skin-rotate-hint" data-skin-hint>{tr("pages.skin.dragToRotate")}</p>
          {readonly ? (
            <p className="skin-account-hint" data-skin-account-hint>
              {accountSkin.loading
                ? tr("pages.skin.loadingServerSkin")
                : previewTexture
                  ? tr("pages.skin.serverSkinHint")
                  : tr("pages.skin.serverSkinMissing", { error: accountSkin.error ?? tr("pages.skin.serverSkinNoError") })}
            </p>
          ) : null}
        </section>

        <section className={`panel skin-library ${dragging ? "is-dragging" : ""}`} data-skin-library>
          <div className="segmented skin-tabs" role="tablist" aria-label={tr("pages.skin.skinListAria")}>
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
                {tr(TAB_LABEL_KEY[key])} {key === "saved" ? userSkins.length : officialSkins.length}
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
            <span className="field-label">{tr(TAB_LABEL_KEY[tab])}</span>
            <span className="panel-count">
              {tr("pages.skin.countSkins", {
                count: listSkins.length,
                extra: tab === "official" ? tr("pages.skin.officialReadonlySuffix") : "",
              })}
            </span>
            <IconChevronDown size={15} className={`skin-fold-icon ${foldOpen ? "is-open" : ""}`.trim()} />
          </button>

          {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
          {!error && loading && skins === null ? <SkeletonCards count={2} /> : null}

          {foldOpen && !error ? (
            <>
              {skins !== null && listSkins.length === 0 ? (
                <EmptyState
                  title={tr(tab === "saved" ? "pages.skin.emptySavedSkins" : "pages.skin.emptyBuiltinSkins")}
                  hint={tr(tab === "saved" ? "pages.skin.emptySavedSkinsHint" : "pages.skin.emptyBuiltinSkinsHint")}
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
                    <span>{importing ? tr("pages.skin.importing") : tr("pages.skin.addSkin")}</span>
                    <span className="skin-add-hint">{tr("pages.skin.addSkinHint")}</span>
                  </button>
                )}
              </div>
            </>
          ) : null}
        </section>
      </div>

      {/* 微软正版：官方档案里的皮肤与披风（账号在 Mojang 那边，进游戏即生效） */}
      <section
        className={`panel skin-mojang ${mojangLocked ? "is-locked" : ""}`.trim()}
        data-mojang-skin={mojangProfile?.name ?? "none"}
        data-mojang-locked={mojangLocked ? "true" : undefined}
      >
        <div className="panel-head">
          <h2 className="panel-title">{tr("pages.skins.title")}</h2>
          <span className="panel-count">
            {mojangLocked
              ? tr("pages.skins.lockedTitle")
              : mojangLoading
                ? tr("pages.skins.loading")
                : tr("pages.skins.capeCount", { count: mojangCapes.length })}
          </span>
        </div>

        {mojangLocked ? (
          <p className="skin-account-hint" data-mojang-login-hint>{tr("pages.skins.lockedHint")}</p>
        ) : (
          <>
            <div className="skin-mojang-body">
              <div className="skin-mojang-preview">
                <span className="skin-name" data-mojang-skin-name>{mojangProfile?.name ?? account?.name ?? ""}</span>
                <SkinDoll texture={mojangTexture} cape={mojangCapeTexture} emptyHint={tr("pages.skins.noSkin")} />
                <span className="badge skin-mojang-variant" data-mojang-variant={mojangActiveSkin?.variant ?? "none"}>
                  {mojangActiveSkin?.variant === "slim" ? tr("pages.skins.variantSlim") : tr("pages.skins.variantClassic")}
                </span>
              </div>

              {/* 上传：本地 PNG（multipart）为主，图片直链（JSON）作为备用通道 */}
              <div className="skin-mojang-actions" data-mojang-upload>
                <div className="skin-mojang-row">
                  <Select
                    value={mojangVariant}
                    options={[
                      { value: "classic", label: tr("pages.skins.variantClassic") },
                      { value: "slim", label: tr("pages.skins.variantSlim") },
                    ]}
                    onChange={(value) => setMojangVariant(value === "slim" ? "slim" : "classic")}
                    ariaLabel={tr("pages.skins.variantHint")}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-action="mojang-skin-upload"
                    data-mojang-upload-file
                    onClick={() => void uploadMojangFromFile()}
                    disabled={mojangBusy === "upload"}
                  >
                    <IconPlus size={16} />
                    {mojangBusy === "upload" ? tr("pages.skins.uploading") : tr("pages.skins.pickPng")}
                  </button>
                </div>
                <p className="skin-account-hint">{tr("pages.skins.variantHint")}</p>
                <div className="skin-mojang-row">
                  <TextInput
                    className="skin-mojang-url"
                    data-mojang-url
                    value={mojangUrl}
                    onChange={(event) => setMojangUrl(event.target.value)}
                    placeholder={tr("pages.skins.urlPlaceholder")}
                    aria-label={tr("pages.skins.urlLabel")}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-action="mojang-skin-upload"
                    data-mojang-upload-url
                    onClick={() => void uploadMojangFromUrl()}
                    disabled={mojangBusy === "url"}
                  >
                    <IconLink size={14} />
                    {tr("pages.skins.urlApply")}
                  </button>
                </div>
                <div className="skin-mojang-row">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-action="mojang-skin-reload"
                    onClick={() => {
                      if (microsoftAccount) void loadMojang(microsoftAccount.id);
                    }}
                    disabled={mojangLoading}
                  >
                    <IconRefresh size={14} />
                    {mojangLoading ? tr("pages.skins.loading") : tr("pages.skins.reload")}
                  </button>
                  <span className="skin-account-hint">{tr("pages.skins.sub")}</span>
                </div>
              </div>
            </div>

            <div className="skin-mojang-capes" data-mojang-cape-list>
              <div className="panel-head">
                <h3 className="panel-title">{tr("pages.skins.capes")}</h3>
                <div className="skin-mojang-cape-tools">
                  <span className="panel-count">{tr("pages.skins.capeCount", { count: mojangCapes.length })}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-action="mojang-cape-refresh"
                    onClick={() => void refreshMojangCapes()}
                    disabled={mojangBusy === "refresh"}
                  >
                    <IconRefresh size={14} />
                    {mojangBusy === "refresh" ? tr("pages.skins.refreshing") : tr("pages.skins.refresh")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-action="mojang-cape-remove"
                    onClick={() => void applyMojangCape(null)}
                    disabled={mojangActiveCape === null || mojangCapeBusy !== null}
                    title={tr("pages.skins.capeRemove")}
                  >
                    <IconTrash size={14} />
                    {tr("pages.skins.capeRemove")}
                  </button>
                </div>
              </div>

              <div className="skin-cape-current">
                {mojangCapeTexture && !mojangCapeBroken ? (
                  <img
                    className="skin-cape-thumb"
                    src={mojangCapeTexture.url}
                    alt=""
                    width={66}
                    height={33}
                    onError={() => setMojangCapeBroken(true)}
                  />
                ) : (
                  <span className="skin-cape-thumb skin-cape-thumb-empty" data-skin-cape-empty aria-hidden="true" />
                )}
                <div className="skin-cape-current-text">
                  <span className="skin-cape-name" data-mojang-cape-current>
                    {mojangActiveCape ? capeLabel(mojangActiveCape) : tr("pages.skins.noCape")}
                  </span>
                  <p className="skin-account-hint">{tr("pages.skins.currentCape")}</p>
                </div>
              </div>

              {mojangCapes.length === 0 ? (
                <EmptyState title={tr("pages.skins.capeEmpty")} hint={tr("pages.skins.capeEmptyHint")} />
              ) : (
                <div className="skin-grid skin-cape-grid" data-mojang-cape-grid>
                  {mojangCapes.map((cape) => {
                    const active = cape.id === mojangActiveCape?.id;
                    const busy = mojangCapeBusy === cape.id;
                    const broken = mojangCapeBrokenIds.includes(cape.id);
                    return (
                      <div
                        key={cape.id}
                        className={`skin-card ${active ? "is-active" : ""}`.trim()}
                        data-mojang-cape={cape.id}
                        data-mojang-cape-active={active ? "true" : "false"}
                        data-mojang-cape-state={cape.state}
                      >
                        <div className="skin-card-main">
                          {broken ? (
                            <span className="skin-cape-thumb skin-cape-thumb-empty" title={tr("pages.skins.capeImageFailed")} aria-hidden="true" />
                          ) : (
                            <img
                              className="skin-cape-thumb"
                              src={cape.url}
                              alt=""
                              width={64}
                              height={32}
                              onError={() => setMojangCapeBrokenIds((prev) => (prev.includes(cape.id) ? prev : [...prev, cape.id]))}
                            />
                          )}
                          <span className="skin-card-name">{capeLabel(cape)}</span>
                          <span className="skin-card-meta">{cape.alias ? cape.id.slice(0, 8) : cape.state || "—"}</span>
                        </div>
                        <button
                          type="button"
                          className={`skin-card-apply ${active ? "is-active" : ""}`.trim()}
                          data-action="mojang-cape-apply"
                          onClick={() => void applyMojangCape(cape.id)}
                          disabled={active || busy || mojangCapeBusy !== null}
                        >
                          {active ? <IconCheck size={14} /> : null}
                          {active
                            ? tr("pages.skins.inUse")
                            : busy
                              ? tr("pages.skins.capeApplying")
                              : tr("pages.skins.capeApply")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      <section className="panel skin-capes" data-skin-capes>
        <div className="panel-head">
          <h2 className="panel-title">{tr("pages.skin.capesTitle")}</h2>
          <span className="panel-count">
            {capeEditable
              ? tr("pages.skin.capeCountEditable", { saved: userCapes.length, builtin: officialCapes.length })
              : tr("pages.skin.capeCountReadonly")}
          </span>
        </div>

        <div className="skin-cape-current">
          {previewCape ? (
            <img className="skin-cape-thumb" src={previewCape.url} alt="" width={66} height={33} />
          ) : (
            <span className="skin-cape-thumb skin-cape-thumb-empty" data-skin-cape-empty aria-hidden="true" />
          )}
          <div className="skin-cape-current-text">
            <span className="skin-cape-name" data-skin-cape-name>
              {previewCape
                ? (previewCape.source === "local"
                  ? previewCape.label
                  : (capeReadonlyType === "microsoft"
                    ? tr("pages.skin.officialCape")
                    : tr("pages.skin.serverCape")))
                : (capeReadonlyType ? tr("pages.skin.noCapeForAccount") : tr("pages.skin.noCapeSet"))}
            </span>
            {capeReadonlyType ? (
              <p className="skin-account-hint" data-cape-readonly={capeReadonlyType}>
                {tr(CAPE_READONLY_HINT_KEY[capeReadonlyType])}
              </p>
            ) : (
              <p className="skin-account-hint">{tr("pages.skin.capeLocalHint")}</p>
            )}
          </div>
        </div>

        {/* 与皮肤同款两段：已保存（用户导入，可增删）/ 内置（随程序分发，只读） */}
        <div className="segmented skin-tabs" role="tablist" aria-label={tr("pages.skin.capeListAria")}>
          {(["saved", "official"] as CapeTab[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={capeTab === key}
              className={`segmented-item ${capeTab === key ? "active" : ""}`.trim()}
              data-cape-tab={key}
              onClick={() => setCapeTab(key)}
            >
              {tr(CAPE_TAB_LABEL_KEY[key])} {key === "saved" ? userCapes.length : officialCapes.length}
            </button>
          ))}
        </div>

        {capes !== null && listCapes.length === 0 ? (
          <EmptyState
            title={tr(capeTab === "saved" ? "pages.skin.emptySavedCapes" : "pages.skin.emptyBuiltinCapes")}
            hint={
              capeTab === "saved"
                ? tr(capeEditable ? "pages.skin.emptySavedCapesHint" : "pages.skin.emptyCapeReadonlyHint")
                : tr("pages.skin.emptyBuiltinCapesHint")
            }
          />
        ) : null}

        <div className="skin-grid skin-cape-grid" data-cape-grid>
          {listCapes.map((item) => {
            // 微软 / 第三方：整块只读——卡片灰化，点一下只说明原因，不发请求。
            const locked = !capeEditable;
            const lockedHint = capeReadonlyType ? tr(CAPE_READONLY_HINT_KEY[capeReadonlyType]) : tr("pages.skin.pickAccountFirst");
            return (
              <div
                key={item.fileName}
                className={`skin-card ${item.active ? "is-active" : ""} ${locked ? "is-locked" : ""}`.trim()}
                data-cape-card={item.fileName}
                data-cape-source={item.source}
                data-cape-locked={locked ? "true" : undefined}
              >
                <button
                  type="button"
                  className="skin-card-main"
                  data-action="select-cape"
                  onClick={() => {
                    if (locked) {
                      push(lockedHint, "info");
                      return;
                    }
                    void selectCape(item.fileName);
                  }}
                  disabled={capeBusy === item.fileName}
                  aria-disabled={locked || undefined}
                  title={locked ? lockedHint : `${item.fileName} · ${item.width}×${item.height}`}
                >
                  <img className="skin-cape-thumb" src={skinImageUrl(item.path)} alt="" width={64} height={32} />
                  <span className="skin-card-name">{item.name}</span>
                  <span className="skin-card-meta">
                    {item.source === "official" ? tr("pages.skin.builtinReadonlyMeta") : ""}
                    {item.width}×{item.height}
                  </span>
                </button>
                {item.active ? <span className="badge skin-active-tag">{tr("pages.skin.inUse")}</span> : null}
                {/* 内置披风没有删除入口（与内置皮肤一致），只读账号也不给删 */}
                {capeEditable && item.source === "user" ? (
                  <button
                    type="button"
                    className="skin-card-del"
                    data-action="delete-cape"
                    onClick={() => setCapeToDelete(item.fileName)}
                    disabled={capeBusy === item.fileName}
                    title={tr("pages.skin.deleteCapeFromLibrary")}
                  >
                    <IconTrash size={14} />
                    {tr("pages.common.delete")}
                  </button>
                ) : null}
              </div>
            );
          })}
          {/* 「添加披风」只属于用户自己的披风库：内置披风随程序分发，用户不该改它 */}
          {capeEditable && capeTab === "saved" ? (
            <button
              type="button"
              className="skin-add skin-cape-add"
              data-cape-add
              onClick={() => capeInputRef.current?.click()}
              disabled={capeImporting}
              title={tr(CAPE_RULE_KEY)}
            >
              <IconPlus size={18} />
              <span>{capeImporting ? tr("pages.skin.importing") : tr("pages.skin.addCape")}</span>
              <span className="skin-add-hint">{tr(CAPE_RULE_KEY)}</span>
            </button>
          ) : null}
        </div>
      </section>

      <footer className="skin-recommend">
        <span>{tr("pages.skin.recommendLittleSkin")}</span>
        <button type="button" className="account-link" data-action="open-littleskin" onClick={() => void openLittleSkin()}>
          <IconLink size={14} />
          {LITTLESKIN_URL}
        </button>
        <span className="skin-recommend-sep" aria-hidden="true">·</span>
        <span>{tr("pages.skin.recommendMcstat")}</span>
        <button type="button" className="account-link" data-action="open-mcstat" onClick={() => void openMcstat()}>
          <IconLink size={14} />
          {MCSTAT_URL}
        </button>
      </footer>

      <input ref={fileInputRef} type="file" accept="image/png" multiple hidden onChange={(event) => void onPickFiles(event)} />
      <input ref={capeInputRef} type="file" accept="image/png" multiple hidden onChange={(event) => void onPickCapeFiles(event)} />
      <ConfirmDialog
        open={toDelete !== null}
        title={tr("pages.skin.deleteSkinTitle")}
        message={toDelete ? tr("pages.skin.deleteSkinMessage", { name: toDelete }) : ""}
        confirmText={tr("pages.common.delete")}
        danger
        busy={busyFile !== null}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) void removeSkin(toDelete);
        }}
      />
      <ConfirmDialog
        open={capeToDelete !== null}
        title={tr("pages.skin.deleteCapeTitle")}
        message={capeToDelete ? tr("pages.skin.deleteCapeMessage", { name: capeToDelete }) : ""}
        confirmText={tr("pages.common.delete")}
        danger
        busy={capeBusy !== null}
        onCancel={() => setCapeToDelete(null)}
        onConfirm={() => {
          if (capeToDelete) void removeCape(capeToDelete);
        }}
      />
    </section>
  );
}