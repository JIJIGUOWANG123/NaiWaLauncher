import { useEffect, useMemo, useRef, useState } from "react";
import type { InstalledContentRef, InstanceMeta, LoaderKind, ModFileInfo } from "../../shared/types";
import type { ModInstallResult } from "../../shared/ipc";
import { api } from "../lib/api";
import { loaderLabel } from "../lib/format";
import { useT } from "../lib/i18n";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { IconAlert, IconCheck, IconChevronDown, IconInfo } from "../components/icons";

/** 联机模组在 Modrinth 上的固定标识（已核对，不要再猜别处的 id）。 */
export type LanModKey = "offlinelan" | "mcwifipnp" | "lan-properties" | "lan-server-properties";

export interface LanModDef {
  key: LanModKey;
  slug: string;
  projectId: string;
  /** 项目名本身不翻译，界面文案里直接用。 */
  name: string;
  /** 已装判定的模糊词：文件名 / modId / 显示名去掉分隔符后做子串匹配。 */
  aliases: string[];
}

export const LAN_MODS: Record<LanModKey, LanModDef> = {
  offlinelan: {
    key: "offlinelan", slug: "offlinelan", projectId: "pimmstPB", name: "OfflineLAN", aliases: ["offlinelan"],
  },
  mcwifipnp: {
    key: "mcwifipnp",
    slug: "mcwifipnp",
    projectId: "RTWpcTBp",
    name: "LAN World Plug-n-Play",
    // 站点上的文件名用项目自己的 slug（lan-world-plug-n-play），三种写法都认。
    aliases: ["mcwifipnp", "lanworldplugnplay", "lanworldplugandplay"],
  },
  "lan-properties": {
    key: "lan-properties", slug: "lan-properties", projectId: "deYSo63V", name: "LAN Properties", aliases: ["lanproperties"],
  },
  "lan-server-properties": {
    key: "lan-server-properties",
    slug: "lan-server-properties",
    projectId: "SqnBX2qd",
    name: "LAN Server Properties",
    aliases: ["lanserverproperties"],
  },
};

/** 实例的 loader 里没有 legacy-fabric，但 LAN Properties 在站点上按 legacy-fabric 发布，判定矩阵要能表达它。 */
export type LanLoader = LoaderKind | "legacy-fabric";

/**
 * 推荐矩阵：按加载器给出有序候选，前面的查不到文件才回退到后面那个。
 * Fabric / Quilt → OfflineLAN（回退 mcwifipnp → LAN Properties → LAN Server Properties）；
 * Forge / NeoForge / Legacy Fabric → mcwifipnp（回退 LAN Properties → LAN Server Properties）；
 * 原版另有提示；没有候选的加载器（liteloader）返回空数组，由调用方按 unsupported 处理。
 */
export function lanModCandidates(loader: LanLoader): LanModKey[] {
  switch (loader) {
    case "fabric":
    case "quilt":
      // 首选 OfflineLAN，但它覆盖的 MC 版本少：没文件时依次回退 mcwifipnp、LAN Properties、LAN Server Properties。
      return ["offlinelan", "mcwifipnp", "lan-properties", "lan-server-properties"];
    case "forge":
    case "neoforge":
    case "legacy-fabric":
      // mcwifipnp 四种加载器都有发布，比只发 Forge/NeoForge 的 LAN Properties 更通用，所以放首位兜底。
      return ["mcwifipnp", "lan-properties", "lan-server-properties"];
    default:
      return [];
  }
}

export type LanAvailability = "yes" | "no" | "unknown";

/** 候选里第一个「站点上有当前版本+加载器文件」的那个。 */
export function pickLanMod(
  candidates: LanModKey[],
  availability: Partial<Record<LanModKey, LanAvailability>>,
): LanModKey | null {
  for (const key of candidates) {
    if (availability[key] === "yes") return key;
  }
  return null;
}

/** 用户的选择：auto = 跟随推荐矩阵（含自动回退）；其余 = 用户点名要哪一个，选了就不再自动回退。 */
export type LanChoice = "auto" | LanModKey;

/** 按实例记住选择：键形如 naiwa.lanmod.choice.<instanceId>，实例删了这条记录自然失效。 */
export const LAN_CHOICE_STORAGE_PREFIX = "naiwa.lanmod.choice.";

export function lanChoiceStorageKey(instanceId: string): string {
  return LAN_CHOICE_STORAGE_PREFIX + instanceId;
}

/** 只认已知的模组 key 与 "auto"：存坏了（改过版本/手改 localStorage）就退回自动。 */
export function parseLanChoice(raw: string | null | undefined): LanChoice {
  if (!raw) return "auto";
  if (raw === "auto") return "auto";
  return raw in LAN_MODS ? (raw as LanModKey) : "auto";
}

function choiceStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // 隐私模式里访问 localStorage 会抛，按「没有记忆」处理。
    return null;
  }
}

export function readLanChoice(instanceId: string): LanChoice {
  const store = choiceStorage();
  if (!store || !instanceId) return "auto";
  try {
    return parseLanChoice(store.getItem(lanChoiceStorageKey(instanceId)));
  } catch {
    return "auto";
  }
}

export function writeLanChoice(instanceId: string, choice: LanChoice): void {
  const store = choiceStorage();
  if (!store || !instanceId) return;
  try {
    store.setItem(lanChoiceStorageKey(instanceId), choice);
  } catch {
    // 存不进去只影响下次记忆，不影响这次的选择。
  }
}

/** 记忆值已不在候选里（例如换过加载器）时回落推荐，并把旧值清掉。 */
export function resolveStoredChoice(instanceId: string, candidates: LanModKey[]): LanChoice {
  const stored = readLanChoice(instanceId);
  if (stored === "auto") return "auto";
  if (candidates.includes(stored)) return stored;
  writeLanChoice(instanceId, "auto");
  return "auto";
}

/** 安装目标：以「下拉当前值」为准；只有自动模式才回落到推荐项。 */
export function lanInstallTarget(selectValue: string, plan: LanPlan): LanModKey | null {
  const parsed = parseLanChoice(selectValue);
  return parsed === "auto" ? plan.mod : parsed;
}

/** 下拉旁边那个按钮的状态：选中项已经装着就显示「已安装」并禁用，其余情况可点。 */
export function lanInstallButton(
  plan: LanPlan,
  installMod: LanModKey | null,
): { disabled: boolean; installed: boolean } {
  const installed = installMod !== null && installMod === plan.mod && plan.install === "installed";
  return { disabled: installMod === null || installed, installed };
}

/** 真正下发安装：projectId 跟着选中的模组走，自检用它断言「点按钮装的是下拉里那一个」。 */
export async function installLanMod(req: {
  instanceId: string;
  mod: LanModKey;
  fileId?: string;
}): Promise<ModInstallResult> {
  return api.mods.install({
    provider: "modrinth",
    projectId: LAN_MODS[req.mod].projectId,
    fileId: req.fileId,
    instanceId: req.instanceId,
    kind: "mod",
    installDependencies: true,
  });
}

/** 下拉显示的值：自动模式下落在「当前推荐的那一个」上，用户一眼就能看出默认就是推荐。 */
export function choiceSelectValue(choice: LanChoice, plan: LanPlan): string {
  if (choice !== "auto") return choice;
  return plan.mod ?? "auto";
}

export interface LanChoiceOption {
  key: LanModKey | "auto";
  label: string;
  available: LanAvailability;
  selected: boolean;
}

/**
 * 下拉选项：不适配的模组不删掉，只在文案上标注（「LAN Properties（MC 1.21.4 无可用文件）」），
 * 用户仍然可以选——他可能想装最新版或回头换版本。
 */
export function lanChoiceOptions(
  candidates: LanModKey[],
  availability: Partial<Record<LanModKey, LanAvailability>>,
  selectValue: string,
  mcVersion: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): LanChoiceOption[] {
  const anyYes = pickLanMod(candidates, availability) !== null;
  const allNo = candidates.length > 0 && candidates.every((key) => availability[key] === "no");
  const options: LanChoiceOption[] = [{
    key: "auto",
    label: t("pages.lanMod.choiceAuto"),
    available: anyYes ? "yes" : allNo ? "no" : "unknown",
    selected: selectValue === "auto",
  }];
  for (const key of candidates) {
    const available = availability[key] ?? "unknown";
    const suffix = available === "no"
      ? t("pages.lanMod.choiceOptionNoFile", { version: mcVersion })
      : available === "unknown"
        ? t("pages.lanMod.choiceOptionUnknown")
        : "";
    options.push({
      key,
      label: LAN_MODS[key].name + suffix,
      available,
      selected: selectValue === key,
    });
  }
  return options;
}

export type OfflineLanState = "no-instance" | "vanilla" | "missing" | "unsupported" | "ok";
/** host = 自己是房主（要自己装）；guest = 自己只是房客（让房主装/确认）。 */
export type OfflineLanSide = "host" | "guest";
/** 常驻的那行安装状态：未选实例 / 无可用方案 / 未安装 / 已装且匹配 / 已装但版本不匹配。 */
export type LanInstallStatus = "no-instance" | "unavailable" | "missing" | "installed" | "mismatch";

export interface LanInstalledInfo {
  fileName: string;
  /** 文件名加号后面那段 MC 版本（offlinelan-2.0.0+1.21.4.jar → 1.21.4）；没有就是 null。 */
  mcVersion: string | null;
  /** 文件名里的模组版本；解析不到就是 null。 */
  version: string | null;
}

export interface LanFacts {
  instance: Pick<InstanceMeta, "mcVersion" | "loader"> | null;
  availability: Partial<Record<LanModKey, LanAvailability>>;
  installed: Partial<Record<LanModKey, LanInstalledInfo>>;
  /** 用户手选的模组；缺省/auto = 跟随推荐矩阵。 */
  choice?: LanChoice;
}

/** 实例里装着的「另一个」联机模组（不是当前推荐项）：状态行要指出来并给卸载按钮。 */
export interface LanOtherMod {
  key: LanModKey;
  name: string;
  version: string | null;
  /** 卸载要按文件名删，所以条目必须带上它。 */
  fileName: string;
}

/** 同时装多个联机模组会互相抢 LAN 端口，列表最多列这么多，避免撑破提示卡。 */
export const MAX_OTHER_LAN_MODS = 4;

/** 已装但不是推荐项的那些联机模组：顺序跟着 LAN_MODS 声明走，结果稳定，自检可以断言。 */
export function otherLanMods(
  installed: Partial<Record<LanModKey, LanInstalledInfo>>,
  mod: LanModKey | null,
  limit = MAX_OTHER_LAN_MODS,
): LanOtherMod[] {
  const list: LanOtherMod[] = [];
  for (const key of Object.keys(LAN_MODS) as LanModKey[]) {
    if (key === mod) continue;
    const info = installed[key];
    if (!info) continue;
    list.push({ key, name: LAN_MODS[key].name, version: info.version, fileName: info.fileName });
  }
  return list.slice(0, limit);
}

export interface LanPlan {
  state: OfflineLanState;
  /** 推荐的那个模组；没有可用方案时 null。 */
  mod: LanModKey | null;
  install: LanInstallStatus;
  installed: LanInstalledInfo | null;
  /** 走回退时，被跳过的那个候选（用于「已回退」提示）。 */
  fallbackFrom: LanModKey | null;
  /** 回退是因为「查询失败」而不是「确实没有文件」——提示语要分开写。 */
  fallbackUnknown: boolean;
  /** 候选全都查不到文件（不是网络失败）。 */
  noFiles: boolean;
  /** 实例里另外装着的联机模组（不是推荐项），最多 MAX_OTHER_LAN_MODS 个。 */
  others: LanOtherMod[];
  /** 用户点名选中的模组（auto 时为 null）——它才是安装/已装判定的对象。 */
  choice: LanModKey | null;
  /** 手选的模组在当前版本没有可用文件（界面不给必然失败的安装按钮）。 */
  choiceUnavailable: boolean;
}

function fallbackOf(candidates: LanModKey[], chosen: LanModKey | null): LanModKey | null {
  if (!chosen) return null;
  const index = candidates.indexOf(chosen);
  return index > 0 ? candidates[index - 1] : null;
}

/**
 * 推荐 + 已装一起算：先按加载器挑候选，再对照站点文件与实例里已装的内容。
 * 已装但文件名里的 MC 版本和实例对不上 = 等于没装：状态仍归 unsupported，但安装状态行会说清原因。
 */
export function resolveLanPlan(facts: LanFacts): LanPlan {
  const base: LanPlan = {
    state: "no-instance",
    mod: null,
    install: "no-instance",
    installed: null,
    fallbackFrom: null,
    fallbackUnknown: false,
    noFiles: false,
    others: [],
    choice: null,
    choiceUnavailable: false,
  };
  const instance = facts.instance;
  if (!instance) return base;
  if (instance.loader === "vanilla") return { ...base, state: "vanilla", install: "unavailable" };

  const candidates = lanModCandidates(instance.loader);
  if (candidates.length === 0) return { ...base, state: "unsupported", install: "unavailable" };

  const noFiles = candidates.every((key) => facts.availability[key] === "no");

  // 用户手选：以他为准，不再自动回退；选到当前版本没文件的模组也不改口，只把安装按钮收起来并说明原因。
  const chosen = facts.choice && facts.choice !== "auto" && candidates.includes(facts.choice) ? facts.choice : null;
  if (chosen) {
    const chosenAvailability = facts.availability[chosen] ?? "unknown";
    const chosenInstalled = facts.installed[chosen] ?? null;
    const chosenOthers = otherLanMods(facts.installed, chosen);
    if (!chosenInstalled) {
      return {
        ...base,
        state: "missing",
        mod: chosen,
        install: "missing",
        choice: chosen,
        choiceUnavailable: chosenAvailability === "no",
        noFiles,
        others: chosenOthers,
      };
    }
    const chosenMismatched = chosenInstalled.mcVersion !== null
      && chosenInstalled.mcVersion !== instance.mcVersion;
    return {
      state: chosenMismatched ? "unsupported" : "ok",
      mod: chosen,
      install: chosenMismatched ? "mismatch" : "installed",
      installed: chosenInstalled,
      fallbackFrom: null,
      fallbackUnknown: false,
      noFiles,
      others: chosenOthers,
      choice: chosen,
      choiceUnavailable: chosenAvailability === "no",
    };
  }

  const withFiles = pickLanMod(candidates, facts.availability);
  // 站点上一个可用文件都没有时，只要实例里已经装了候选之一，仍按它显示安装状态（比「不支持」更有用）。
  const mod = withFiles ?? candidates.find((key) => facts.installed[key]) ?? null;
  if (!mod) {
    // 查询失败（unknown）不能说成「不支持」：留 missing，界面给重试。
    return {
      ...base,
      state: noFiles ? "unsupported" : "missing",
      install: "unavailable",
      noFiles,
      others: otherLanMods(facts.installed, null),
    };
  }

  const fallbackFrom = fallbackOf(candidates, withFiles);
  const fallbackUnknown = fallbackFrom !== null && facts.availability[fallbackFrom] === "unknown";
  // 已装的其它联机模组：推荐项自己不算，它们才是要卸载/换装的对象。
  const others = otherLanMods(facts.installed, mod);
  const installed = facts.installed[mod] ?? null;
  if (!installed) {
    return { ...base, state: "missing", mod, install: "missing", fallbackFrom, fallbackUnknown, noFiles, others };
  }
  const mismatched = installed.mcVersion !== null && installed.mcVersion !== instance.mcVersion;
  return {
    state: mismatched ? "unsupported" : "ok",
    mod,
    install: mismatched ? "mismatch" : "installed",
    installed,
    fallbackFrom,
    fallbackUnknown,
    noFiles,
    others,
    choice: null,
    choiceUnavailable: false,
  };
}

export interface LanViewOptions {
  t: (key: string, vars?: Record<string, string | number>) => string;
  side: OfflineLanSide;
  /** 探测是否已经给出这个实例的结果；false 时只显示「正在检查…」。 */
  settled: boolean;
  mcVersion: string;
  loader: string;
  /** 查询本身失败了（网络/来源站），界面给「重试」。 */
  queryFailed: boolean;
}

/** 状态行 + 说明行 + 按钮可见性：组件直接渲染这几个字段，自检也断言它。 */
export interface LanView {
  /** 常驻状态行的取值（data-ol-status）。 */
  status: LanInstallStatus | "checking";
  statusText: string;
  note: string | null;
  hint: string | null;
  showInstall: boolean;
  showRetry: boolean;
  /** 已装的其它联机模组（推荐项除外）：组件按它逐个渲染卸载条目。 */
  otherMods: LanOtherMod[];
  /** 卸载按钮是否可见（有别的联机模组装着就可见）。 */
  showUninstall: boolean;
  /** 换装 / 多装冲突提示；没有其它联机模组时为 null。 */
  otherHint: string | null;
  /** 用户手选了模组时的说明行（已按你的选择：X）；auto 时为 null。 */
  choiceNote: string | null;
  /** 手选的模组在当前版本没有文件时的明确提示（data-ol-mismatch）；其余情况为 null。 */
  unavailableHint: string | null;
}

export function describeLanPlan(plan: LanPlan, options: LanViewOptions): LanView {
  const { t, side, settled, mcVersion, loader } = options;
  const modName = plan.mod ? LAN_MODS[plan.mod].name : "";
  const status = settled ? plan.install : "checking";
  if (!settled) {
    return {
      status,
      statusText: t("pages.lanMod.checking"),
      note: null,
      hint: null,
      showInstall: false,
      showRetry: false,
      otherMods: [],
      showUninstall: false,
      otherHint: null,
      choiceNote: null,
      unavailableHint: null,
    };
  }

  // 装着的是「另一个」联机模组：状态行直接点名，并给卸载入口，卸载完再装推荐的那个。
  const otherMods = plan.others;
  const otherNames = otherMods.map((item) => item.name).join(", ");

  // 走了回退就在状态行尾巴上写清原因：推荐项不是首选这件事必须让用户看见。
  const fallbackSuffix = plan.fallbackFrom
    ? (plan.fallbackUnknown
      ? t("pages.lanMod.fallbackUnknown", { skipped: LAN_MODS[plan.fallbackFrom].name })
      : t("pages.lanMod.fallback", { skipped: LAN_MODS[plan.fallbackFrom].name, version: mcVersion }))
    : "";

  const statusText = (() => {
    if (plan.state === "vanilla") return t("pages.lanMod.vanillaStatus");
    if (plan.install === "no-instance") return t("pages.lanMod.noInstance");
    if (plan.install === "unavailable") return t("pages.lanMod.unavailable");
    if (plan.install === "missing") {
      // 装了别的联机模组 ≠ 什么都没装：状态行必须同时说出「已装谁」和「推荐谁」。
      if (otherMods.length === 1) {
        const other = otherMods[0];
        const key = other.version ? "pages.lanMod.otherInstalled" : "pages.lanMod.otherInstalledBare";
        return t(key, { other: other.name, version: other.version ?? "", recommended: modName }) + fallbackSuffix;
      }
      if (otherMods.length > 1) {
        return t("pages.lanMod.othersInstalled", {
          count: otherMods.length, others: otherNames, recommended: modName,
        }) + fallbackSuffix;
      }
      return t("pages.lanMod.missing", { mod: modName }) + fallbackSuffix;
    }
    if (plan.install === "mismatch") {
      return t("pages.lanMod.mismatch", {
        mod: modName, installedMc: plan.installed?.mcVersion ?? "", mcVersion,
      }) + fallbackSuffix;
    }
    return plan.installed?.version
      ? t("pages.lanMod.installedWithVersion", { mod: modName, version: plan.installed.version })
      : t("pages.lanMod.installed", { mod: modName });
  })();

  const note = (() => {
    if (plan.install === "no-instance") return t("pages.lanMod.noInstanceBody");
    if (plan.state === "vanilla") return t("pages.lanMod.vanillaBody");
    if (plan.install === "unavailable") return t("pages.lanMod.unavailableBody", { version: mcVersion, loader });
    if (plan.install === "missing") {
      return side === "guest"
        ? t("pages.lanMod.guestMissingBody", { mod: modName })
        : t("pages.lanMod.missingBody", { mod: modName });
    }
    if (plan.install === "mismatch") return t("pages.lanMod.mismatchBody", { mod: modName, mcVersion });
    return side === "guest"
      ? t("pages.lanMod.installedGuest", { mod: modName })
      : t("pages.lanMod.installedBody", { mod: modName });
  })();

  const hint = (() => {
    if (plan.install === "missing") {
      return side === "guest" ? t("pages.lanMod.guestDoNotInstall") : t("pages.lanMod.missingGuestHint");
    }
    if ((plan.install === "installed" || plan.install === "mismatch") && side === "guest") {
      return t("pages.lanMod.guestHostHint", { mod: modName });
    }
    return null;
  })();

  // 推荐项已装时只是「多装了一个」：提示卸载，而不是「换装」；
  // 推荐项没装时：一个 → 换装提示（先卸再装），两个以上 → 互相冲突提示（会抢端口）。
  const recommendedInstalled = plan.install === "installed" || plan.install === "mismatch";
  const otherHint = otherMods.length === 0
    ? null
    : recommendedInstalled
      ? t("pages.lanMod.extraConflictHint", { other: otherNames, recommended: modName })
      : otherMods.length > 1
        ? t("pages.lanMod.otherConflictHint", { count: otherMods.length, recommended: modName })
        : t("pages.lanMod.switchModHint", { other: otherNames, recommended: modName });

  return {
    status,
    statusText,
    note,
    hint,
    // 手选了不适配的模组也不禁用安装：用户可能想装最新版，按钮上给提醒就够了。
    showInstall: plan.install === "missing" && side === "host",
    // 只有「查不到文件」才给重试：版本不支持重试也没用。
    showRetry: plan.install === "unavailable" && options.queryFailed,
    otherMods,
    showUninstall: otherMods.length > 0,
    otherHint,
    choiceNote: plan.choice ? t("pages.lanMod.choicePicked", { mod: modName }) : null,
    unavailableHint: plan.choiceUnavailable && !plan.installed
      ? t("pages.lanMod.choiceUnavailableHint", { mod: modName, version: mcVersion, loader })
      : null,
  };
}

/** 卡片根节点上的 data 属性：自检按它们断言，别随手改名。 */
export interface LanDataView {
  state: OfflineLanState | undefined;
  available: "true" | "false" | "unknown";
  installedFlag: "true" | "false" | "unknown";
  mod: string;
  modVersion: string;
  status: LanInstallStatus | "checking";
  projectId: string;
  /** 回退时被跳过的那个候选，没回退就是空串（data-ol-fallback-from）。 */
  fallbackFrom: string;
  /** 另外装着的联机模组数量（data-ol-other-mods），没有就是 "0"。 */
  otherMods: string;
  /** 当前生效的选择（data-ol-choice）：auto 或模组 key。 */
  choice: string;
}

export function lanDataView(
  plan: LanPlan,
  options: { settled: boolean; fileId: string },
): LanDataView {
  return {
    state: options.settled ? plan.state : undefined,
    available: plan.mod ? "true" : options.settled && plan.noFiles ? "false" : "unknown",
    installedFlag: plan.install === "installed" || plan.install === "mismatch"
      ? "true"
      : plan.install === "missing" ? "false" : "unknown",
    mod: plan.mod ?? "",
    modVersion: plan.installed?.version ?? "",
    status: options.settled ? plan.install : "checking",
    projectId: plan.mod ? LAN_MODS[plan.mod].projectId : "",
    fallbackFrom: plan.fallbackFrom ?? "",
    otherMods: String(plan.others.length),
    choice: plan.choice ?? "auto",
  };
}

/**
 * 已装文件里的 MC 版本：
 * 1) Modrinth 新文件名是 slug-模组版本+MC 版本.jar，加号后面那段就是 MC 版本；
 * 2) 老式文件名（lan-properties-1.20.1-1.4.2.jar）没有加号，取「最后一个号段之前」那个 1.x 号段——
 *    要求至少两个号段，避免把单号段的模组版本（offlinelan-2.0.0.jar）误当游戏版本。
 */
export function mcVersionFromFileName(fileName: string): string | null {
  const plus = /\+\s*(\d+\.\d+(?:\.\d+)?)/.exec(fileName);
  if (plus) return plus[1];
  const tokens = fileName.replace(/\.jar$/i, "").split(/[-_\s]+/).filter((token) => /^v?\d+(?:\.\d+)*$/.test(token));
  if (tokens.length < 2) return null;
  const mcToken = tokens.slice(0, -1).find((token) => /^1\.\d{1,2}(?:\.\d{1,2})?$/.test(token));
  return mcToken ?? null;
}

/** 取文件名里最后一个版本号段当模组版本：offlinelan-2.0.0+1.21.4.jar → 2.0.0。 */
export function modVersionFromFileName(fileName: string): string | null {
  const base = fileName.replace(/\.jar$/i, "");
  const head = base.includes("+") ? base.slice(0, base.indexOf("+")) : base;
  const tokens = head.split(/[-_\s]+/).filter((token) => /^v?\d+(?:\.\d+)*$/.test(token));
  if (tokens.length === 0) return null;
  return tokens[tokens.length - 1].replace(/^v/i, "");
}

/** 去掉大小写与分隔符：lan-server-properties 与 LAN Server Properties 都归一到 lanserverproperties。 */
function normalizeRefText(value: string): string {
  return value.toLowerCase().replace(/[\s._-]+/g, "");
}

/** 已装列表里挑某个联机模组：project_id / slug / modId / 文件名 / 显示名五路都认。 */
export function isLanModRef(ref: InstalledContentRef, key: LanModKey): boolean {
  const def = LAN_MODS[key];
  if (ref.projectId === def.projectId || ref.projectId === def.slug) return true;
  // 扫描兜底来的条目没有 projectId，只能靠 modId 与显示名认。
  const text = normalizeRefText(ref.fileName + " " + (ref.modId ?? "") + " " + (ref.name ?? ""));
  return def.aliases.some((alias) => text.includes(alias));
}

/** 实例下拉的默认值：跟当前实例；当前实例为空时留空，渲染「请选择实例」占位。 */
export function defaultInstanceId(currentInstanceId: string | null | undefined): string {
  return currentInstanceId ?? "";
}

/** 下拉选中的实例：手选的 id 在实例列表里找不到（例如刚被删掉）时等同于没选。 */
export function selectedInstance<T extends Pick<InstanceMeta, "id">>(
  instances: readonly T[],
  instanceId: string,
): T | null {
  return instances.find((item) => item.id === instanceId) ?? null;
}

/** 每个模组记住第一次查通的标识（project_id 或 slug），之后每个 tab 只查一次。 */
const resolvedIdentifiers = new Map<LanModKey, string>();

/** 查某个模组在当前版本/加载器下的文件；标识全都不通时返回 null（未知），不要当成「不支持」。 */
async function fetchModFiles(key: LanModKey, mcVersion: string, loader: LoaderKind): Promise<ModFileInfo[] | null> {
  const def = LAN_MODS[key];
  const known = resolvedIdentifiers.get(key);
  const identifiers = known ? [known] : [def.projectId, def.slug];
  for (const projectId of identifiers) {
    try {
      const files = await api.mods.files({
        provider: "modrinth", projectId, kind: "mod", gameVersion: mcVersion, loader,
      });
      resolvedIdentifiers.set(key, projectId);
      return files;
    } catch {
      // 换下一个标识再试；都不通行就交给调用方按「未知」处理。
    }
  }
  return null;
}

interface Probe {
  /** 探测结果属于哪个实例：切实例时旧结果不能拿来下结论。 */
  instanceId: string | null;
  availability: Partial<Record<LanModKey, LanAvailability>>;
  files: Partial<Record<LanModKey, ModFileInfo[]>>;
  installed: Partial<Record<LanModKey, LanInstalledInfo>>;
}

const EMPTY_PROBE: Probe = { instanceId: null, availability: {}, files: {}, installed: {} };

/**
 * 三种联机方式共用的提示卡：手选实例 → 按加载器推荐联机模组 → 三方对照（实例版本/加载器、
 * 站点文件列表、已装文件名）给出常驻的安装状态行，并在房主侧给一键安装。
 * 只读渲染层已有能力（instances / installedContent / files / install），不在主进程加查询。
 */
export function OfflineLanNotice({ side = "host" }: { side?: OfflineLanSide }) {
  const { instances, currentInstanceId } = useApp();
  const t = useT();
  const { push } = useToast();
  const [installing, setInstalling] = useState(false);
  // 正在卸载哪一个联机模组（null = 没有正在进行的卸载）。
  const [uninstalling, setUninstalling] = useState<LanModKey | null>(null);
  // 手选实例：默认跟当前实例；用户选过就保持本页的选择，页面外切换当前实例时再跟一次。
  const [instanceId, setInstanceId] = useState(() => defaultInstanceId(currentInstanceId));
  const lastCurrent = useRef(currentInstanceId);
  useEffect(() => {
    if (lastCurrent.current === currentInstanceId) return;
    lastCurrent.current = currentInstanceId;
    setInstanceId(defaultInstanceId(currentInstanceId));
  }, [currentInstanceId]);

  const selected = useMemo(() => selectedInstance(instances, instanceId), [instances, instanceId]);
  const candidates = selected ? lanModCandidates(selected.loader) : [];

  // 手选模组：按实例从 localStorage 记忆；存着的模组已经不在候选里（换过加载器）就回落推荐。
  const [choice, setChoice] = useState<LanChoice>("auto");
  const choiceInstance = selected?.id ?? "";
  const choiceLoader = selected?.loader ?? "";
  useEffect(() => {
    if (!choiceInstance) {
      setChoice("auto");
      return;
    }
    setChoice(resolveStoredChoice(choiceInstance, lanModCandidates(choiceLoader as LanLoader)));
  }, [choiceInstance, choiceLoader]);
  const chooseMod = (next: LanChoice) => {
    setChoice(next);
    if (choiceInstance) writeLanChoice(choiceInstance, next);
  };
  const probing = Boolean(selected) && selected?.loader !== "vanilla" && candidates.length > 0;

  const probe = useAsync<Probe>(async () => {
    const instance = selected;
    if (!instance || instance.loader === "vanilla") return EMPTY_PROBE;
    const keys = lanModCandidates(instance.loader);
    // 已装列表查不到时按「没装」处理：状态照常显示，安装按钮重复点一次也不会坏。
    const refs = await api.mods.installedContent(instance.id).catch(() => [] as InstalledContentRef[]);
    const installed: Partial<Record<LanModKey, LanInstalledInfo>> = {};
    // 已装判定扫全部联机模组（不只是候选）：装了「另一个」联机模组时要能指出来并给卸载。
    for (const key of Object.keys(LAN_MODS) as LanModKey[]) {
      const ref = refs.find((item) => isLanModRef(item, key));
      if (!ref) continue;
      installed[key] = {
        fileName: ref.fileName,
        mcVersion: mcVersionFromFileName(ref.fileName),
        version: modVersionFromFileName(ref.fileName),
      };
    }
    const availability: Partial<Record<LanModKey, LanAvailability>> = {};
    const files: Partial<Record<LanModKey, ModFileInfo[]>> = {};
    for (const key of keys) {
      const list = await fetchModFiles(key, instance.mcVersion, instance.loader);
      availability[key] = list === null ? "unknown" : list.length > 0 ? "yes" : "no";
      if (list) files[key] = list;
      // 每个候选都要查：选择器上要按模组显示「有没有适配当前版本」，不能提前收工。
    }
    return { instanceId: instance.id, availability, files, installed };
  }, [selected?.id ?? "", selected?.mcVersion ?? "", selected?.loader ?? ""]);

  const settled = !probing || Boolean(probe.data && probe.data.instanceId === selected?.id);
  const probed = settled ? probe.data : null;
  const plan = resolveLanPlan({
    instance: selected,
    availability: probed?.availability ?? {},
    installed: probed?.installed ?? {},
    choice,
  });

  const mcVersion = selected?.mcVersion ?? "";
  const loader = selected ? loaderLabel(selected.loader, t) : "";
  const modFiles = plan.mod ? probed?.files[plan.mod] : undefined;
  const targetFile = modFiles ? (modFiles.find((item) => item.exactMatch) ?? modFiles[0] ?? null) : null;
  const queryFailed = Boolean(probed) && candidates.some((key) => probed?.availability[key] === "unknown");
  const view = describeLanPlan(plan, { t, side, settled, mcVersion, loader, queryFailed });
  const data = lanDataView(plan, { settled, fileId: targetFile?.fileId ?? "" });
  const modName = plan.mod ? LAN_MODS[plan.mod].name : "";
  const skipReason = settled && queryFailed;
  const selectValue = choiceSelectValue(choice, plan);
  const choiceOptions = lanChoiceOptions(candidates, probed?.availability ?? {}, selectValue, mcVersion, t);
  // 下拉旁边那个「立即安装」装的是 selectValue 指向的模组（不是自动推荐项）。
  const installMod = settled ? lanInstallTarget(selectValue, plan) : null;
  // 选中项已经装着：按钮改成「已安装」并禁用，比留着可点更不容易让人重复装。
  const installButton = lanInstallButton(plan, installMod);
  const installDisabled = installing || installButton.disabled;

  const runInstall = async () => {
    if (!selected || !installMod) return;
    const mod = installMod;
    setInstalling(true);
    try {
      // 走现有安装队列：装的是下拉里当前选中的那个模组，装完会出现在「管理」页。
      const result = await installLanMod({
        instanceId: selected.id,
        mod,
        fileId: mod === plan.mod ? targetFile?.fileId : undefined,
      });
      push(t("pages.lanMod.installDone", { mod: LAN_MODS[mod].name, file: result.fileName }), "success");
      // 装完立刻重探：状态行自己变成「已安装 …」。
      probe.reload();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setInstalling(false);
    }
  };

  const runUninstall = async (target: LanOtherMod) => {
    if (!selected) return;
    setUninstalling(target.key);
    try {
      // 走现有卸载通道（mods:remove）：真删文件，成功后 installedContent 也跟着变。
      await api.mods.remove(selected.id, target.fileName, "mod");
      push(t("pages.lanMod.uninstallDone", { mod: target.name }), "success");
      // 卸载完立刻重探：状态行自己回到 missing，并出现「一键安装 推荐项」。
      probe.reload();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setUninstalling(null);
    }
  };

  const icon = !settled ? <IconInfo size={15} />
    : plan.state === "ok" ? <IconCheck size={15} />
      : plan.state === "vanilla" || plan.state === "unsupported" ? <IconAlert size={15} />
        : <IconInfo size={15} />;

  return (
    <div
      className={"net-offlinelan is-" + (settled ? plan.state : "checking")}
      data-offlinelan-state={data.state}
      data-offlinelan-side={side}
      data-offlinelan-installed={plan.installed ? "true" : "false"}
      data-offlinelan-mc={mcVersion}
      data-offlinelan-loader={selected?.loader ?? ""}
      data-offlinelan-available={data.available}
      data-offlinelan-project={data.projectId}
      data-offlinelan-file={targetFile?.fileId ?? ""}
      data-ol-instance={selected?.id ?? ""}
      data-ol-installed={data.installedFlag}
      data-ol-mod={data.mod}
      data-ol-mod-version={data.modVersion}
      data-ol-status={data.status}
      data-ol-candidates={candidates.join(",")}
      data-ol-fallback-from={data.fallbackFrom}
      data-ol-other-mods={data.otherMods}
      data-ol-choice={data.choice}
    >
      {icon}
      <div className="net-offlinelan-body">
        <div className="net-offlinelan-picker">
          <span className="net-offlinelan-picker-label">{t("pages.lanMod.instance")}</span>
          <div className="select-wrap">
            <select
              className="input select net-offlinelan-select"
              data-ol-instance-select
              aria-label={t("pages.lanMod.instance")}
              value={selected ? selected.id : ""}
              onChange={(event) => setInstanceId(event.target.value)}
            >
              {selected ? null : <option value="">{t("pages.lanMod.instancePlaceholder")}</option>}
              {instances.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name + " · " + item.mcVersion + " · " + loaderLabel(item.loader, t)}
                </option>
              ))}
            </select>
            <IconChevronDown size={16} className="select-icon" />
          </div>
        </div>

        {candidates.length > 0 ? (
          <div
            className="net-offlinelan-choice"
            data-ol-choice={choice}
            data-ol-choice-selected={selectValue}
          >
            <span className="net-offlinelan-choice-label">{t("pages.lanMod.choiceLabel")}</span>
            <div className="select-wrap">
              <select
                className="input select net-offlinelan-choice-select"
                data-ol-choice-select
                data-ol-choice-selected={selectValue}
                aria-label={t("pages.lanMod.choiceLabel")}
                value={selectValue}
                onChange={(event) => chooseMod(parseLanChoice(event.target.value))}
              >
                {choiceOptions.map((option) => (
                  <option
                    key={option.key}
                    value={option.key}
                    data-ol-choice-item={option.key}
                    data-ol-choice-available={option.available}
                    data-ol-choice-selected={option.selected ? "true" : "false"}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
              <IconChevronDown size={16} className="select-icon" />
            </div>
            {side === "host" ? (
              <button
                type="button"
                className="btn btn-primary btn-sm net-offlinelan-install"
                data-action="install-offlinelan"
                data-ol-install={installMod ?? ""}
                data-ol-install-disabled={installDisabled ? "true" : "false"}
                title={plan.choiceUnavailable
                  ? t("pages.lanMod.choiceInstallWarning", {
                    mod: installMod ? LAN_MODS[installMod].name : "", version: mcVersion,
                  })
                  : undefined}
                onClick={() => void runInstall()}
                disabled={installDisabled}
              >
                {installing
                  ? t("pages.lanMod.installing")
                  : installButton.installed
                    ? t("pages.lanMod.installedShort")
                    : t("pages.lanMod.installNow")}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="net-offlinelan-statusrow" data-ol-status={data.status}>
          <span className="net-offlinelan-title">{view.statusText}</span>
          {view.showRetry ? (
            <button type="button" className="btn btn-ghost btn-sm" data-ol-action="retry" onClick={() => probe.reload()}>
              {t("pages.lanMod.retry")}
            </button>
          ) : null}
        </div>

        {view.note ? <span className="net-offlinelan-hint">{view.note}</span> : null}
        {view.unavailableHint ? (
          <span className="net-offlinelan-hint net-offlinelan-warn" data-ol-mismatch="true">
            {view.unavailableHint}
          </span>
        ) : null}
        {view.choiceNote ? (
          <span className="net-offlinelan-hint net-offlinelan-reco" data-ol-choice-note={data.choice}>
            {view.choiceNote}
          </span>
        ) : null}
        {settled && plan.mod && !plan.choice ? (
          <span className="net-offlinelan-hint net-offlinelan-reco" data-ol-recommend={plan.mod}>
            {t("pages.lanMod.recommend", { mod: modName, loader })}
          </span>
        ) : null}
        {view.otherMods.length > 0 ? (
          <ul className="net-offlinelan-others" data-ol-others>
            {view.otherMods.map((item) => (
              <li key={item.key} className="net-offlinelan-other" data-ol-other-mod={item.key}>
                <span className="net-offlinelan-other-name">
                  {item.version ? t("pages.lanMod.otherEntry", { mod: item.name, version: item.version }) : item.name}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-action="uninstall-lan-mod"
                  data-ol-other-mod={item.key}
                  data-ol-uninstall={item.key}
                  data-ol-uninstall-file={item.fileName}
                  onClick={() => void runUninstall(item)}
                  disabled={uninstalling !== null}
                >
                  {uninstalling === item.key
                    ? t("pages.lanMod.uninstalling")
                    : t("pages.lanMod.uninstall", { mod: item.name })}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {view.otherHint ? (
          <span className="net-offlinelan-hint net-offlinelan-conflict" data-ol-other-hint>
            {view.otherHint}
          </span>
        ) : null}
        {view.hint ? <span className="net-offlinelan-hint">{view.hint}</span> : null}
        {skipReason && !plan.mod ? (
          <span className="net-offlinelan-hint">{t("pages.lanMod.checkFailedPlain")}</span>
        ) : null}
        {skipReason && plan.mod && plan.install === "missing" ? (
          <span className="net-offlinelan-hint">{t("pages.lanMod.checkFailed", { mod: modName })}</span>
        ) : null}
      </div>
    </div>
  );
}
