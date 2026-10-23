import type {
  CreateInstanceRequest, ModFilesRequest, ModInstallRequest, ModSearchRequest, ModSourceFilter, NaiwaApi, ServerCreateRequest,
} from "../../shared/ipc";
import type {
  Account, DownloadJob, InstalledContentRef, InstalledModInfo, InstanceMeta, InstalledJava, LanAddress, LoaderKind,
  LocalSkin, MapEntry, MicrosoftLoginState, ModCategory, ModContentKind, ModDependency, ModFilterOptions, ModProviderId,
  ModSearchResult,
  NatfrpStatus, NatfrpTunnel, NatfrpUser, PortProbeResult, ServerConsoleLine, ServerCoreId, ServerEntry, ServerStatus,
  SkinInfo, SkinProfile, TaskKind,
  WardrobeSkin,
} from "../../shared/types";
import { loaderLabel } from "../lib/format";
import {
  DEFAULT_SETTINGS, MOCK_ACCOUNTS, MOCK_APP_INFO, MOCK_INSTALLED_JAVA, MOCK_INSTALLED_MODS, MOCK_INSTANCES,
  MOCK_JAVA_RELEASES, MOCK_DATA_ROOT, MOCK_GAME_ROOT, MOCK_CONTENT, MOCK_CONTENT_META, MOCK_MAPS, MOCK_MEDIA,
  MOCK_INSTALLED_PACKS, MOCK_LOCAL_SKINS, MOCK_MOD_DEPENDENCIES, MOCK_MOD_UPDATES, MOCK_PACK_DEPENDENCIES, MOCK_PACK_UPDATES,
  MOCK_SERVER_CORES, MOCK_SERVERS, mockServerBuilds,
  MOCK_ROOT, MOCK_SAVES, MOCK_SCANNED_CONTENT, MOCK_SOURCES, MOCK_STARTUP_SOUND, MOCK_VERSIONS,
  mockDependencyFile, mockDetailFor, mockFiles, mockFindProject, mockIconUrl, mockLoaderVersions,
} from "./data";
import { emitDone, emitProgress, mockBus } from "./emitter";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 浏览器预览下的调用日志：自检脚本据此断言某个 IPC 方法真的被调用过
 * （真实链路看主进程日志，mock 没有主进程可写）。
 */
const callLog: string[] = [];
function trace(method: string, detail?: unknown): void {
  const line = detail === undefined ? method : `${method} ${JSON.stringify(detail)}`;
  callLog.push(line);
  (globalThis as { __naiwaMockCalls?: string[] }).__naiwaMockCalls = callLog;
  console.info("[mock-call]", line);
}

/**
 * 自检钩子：设置 `globalThis.__naiwaMockFailDeps = true` 时 mods.dependencies 一律抛错，
 * 用来验证渲染层「前置检查失败不阻断安装」的降级路径。
 */
function mockDepsFailing(): boolean {
  return Boolean((globalThis as { __naiwaMockFailDeps?: boolean }).__naiwaMockFailDeps);
}

/** 自检钩子：设置 `globalThis.__naiwaMockFailSaves = true` 时 instances.saves 一律抛错，用来验证存档抽屉的错误态与重试。 */
function mockSavesFailing(): boolean {
  return Boolean((globalThis as { __naiwaMockFailSaves?: boolean }).__naiwaMockFailSaves);
}

/**
 * 自检钩子：`globalThis.__naiwaMockDiskUsage = { [instanceId]: number | null }` 覆盖实例的
 * diskUsageBytes（null = 回到「尚未统计」缺省态），用来验证 有值 / 0 B / 计算中 三态文案。
 */
function withMockDiskUsage(item: InstanceMeta): InstanceMeta {
  const overrides = (globalThis as { __naiwaMockDiskUsage?: Record<string, number | null> }).__naiwaMockDiskUsage;
  if (!overrides || !(item.id in overrides)) return item;
  const value = overrides[item.id];
  const next = { ...item };
  if (value === null) delete next.diskUsageBytes;
  else next.diskUsageBytes = value;
  return next;
}

/** 自检钩子：`__naiwaMockExportCancel = true` 时导出返回 path=null（模拟用户取消保存框）。 */
function mockExportCancelled(): boolean {
  return (globalThis as { __naiwaMockExportCancel?: boolean }).__naiwaMockExportCancel === true;
}

/** 自检钩子：`__naiwaMockExportFail` 是字符串时导出抛该错误原文。 */
function mockExportFailure(): string | null {
  const message = (globalThis as { __naiwaMockExportFail?: string }).__naiwaMockExportFail;
  return typeof message === "string" && message ? message : null;
}

/** 自检钩子：`__naiwaMockYggError` 为真时 accounts.loginYggdrasil 按「账号或密码错误」失败。 */
function mockYggLoginError(): string | null {
  const forced = (globalThis as { __naiwaMockYggError?: string | boolean }).__naiwaMockYggError;
  if (!forced) return null;
  return typeof forced === "string" && forced ? forced : "账号或密码错误";
}

/** 自检钩子：`__naiwaMockYggInvalid` 是字符串时 accounts.validateYggdrasil 返回该失败文案。 */
function mockYggInvalidReason(): string | null {
  const reason = (globalThis as { __naiwaMockYggInvalid?: string }).__naiwaMockYggInvalid;
  return typeof reason === "string" && reason ? reason : null;
}

/** 皮肤样例纹理：64×64 RGBA，底色透明（棋盘格能透出来），渲染层直接用 <img> 显示。 */
const MOCK_SKIN_TEXTURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAnklEQVR42u3WwQnCQBRF0SlEXGUl4tKtHdiKYAHahxWkDnf2YC9fEAa+oAExgmbOgbeIYEguA1oKAMALsygxNAGm7nLax9CaCLBezO+rL52vnQABGgmw668PcwJaCQC0ZbU9RN67398cz1FXfzHyZ58+X77XGPcTQIA/C/D1/yECCDBegGcTQIAfD9B1y8gTQIDGAgAAAAAAAAAAk3MDAfN1yzvK5/UAAAAASUVORK5CYII=";
/** 应用皮肤后换成的另一张纹理：用来断言「上传成功后预览真的刷新了」。 */
const MOCK_SKIN_TEXTURE_UPLOADED = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAnklEQVR42u3WsQnCUBSG0axi+xpttHMBwQ2cKE0GcAnHsHQEN7mC8OAJGhAjaO458BcRDMnHA+06AIAX+m2JsQkwd9dTH2NLEWBZNvfVl26vnQABkgS4DOeHOQFZAgC57NaHaPfu94/7IerqL0b72afP195rivsJIMCfBfj6/xABBJguwLMJIMCPByiLVbQTQIBkAQAAAAAAAACA2bkBs6yDw2fy90sAAAAASUVORK5CYII=";
const MOCK_SKIN_PICKED = "C:\\Users\\Public\\Pictures\\NAIWA-skin.png";
const SKIN_NO_UPLOAD_ERROR = "该微软应用尚未获得 Minecraft 服务授权，暂时无法编辑皮肤";

/** 自检钩子：`__naiwaMockSkinNoUpload = true` 时皮肤只读（canUpload=false 并带上原因）。 */
function mockSkinNoUpload(): boolean {
  return (globalThis as { __naiwaMockSkinNoUpload?: boolean }).__naiwaMockSkinNoUpload === true;
}

/** 自检钩子：`__naiwaMockSkinUploadFail` 是字符串时上传抛该错误原文。 */
function mockSkinUploadFailure(): string | null {
  const message = (globalThis as { __naiwaMockSkinUploadFail?: string }).__naiwaMockSkinUploadFail;
  return typeof message === "string" && message ? message : null;
}

/** mock 的衣柜目录：对应主进程的 NaiWa/skins，用来把衣柜文件名还原成绝对路径。 */
const MOCK_SKINS_DIR = `${MOCK_DATA_ROOT}\\skins`;

/** 衣柜种子：3 张 64×64 缩略图（data: URL，浏览器预览下不必真读磁盘）。 */
const MOCK_WARDROBE: { name: string; url: string; sizeBytes: number }[] = [
  {
    name: "ward-quad.png",
    sizeBytes: 4820,
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAfElEQVR42u3QIQHAIBAAQAKipxYEPT1JiKVBfgZasBgv/sQVuBbjOpn2elI1AQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgoEDAPeNk6t+bSoAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECCgQ8AO1PXqVIU+cdQAAAABJRU5ErkJggg==",
  },
  {
    name: "ward-checker.png",
    sizeBytes: 5160,
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAgklEQVR42u3YsRUAEBBEwatLEWpSqAIEeqADYm4C4QUm+m9jjr5Or9R2fK/fBwAAAAAAAJAY4PcP3u4BAAAAAACAzABKEAAAAAAAALAHKEEAAAAAAADAHqAEAQAAAAAAAHuAEgQAAAAAAADsAUoQAAAAAAAAsAcoQQAAAAAAAOA7gA2MT7KkMrHb1gAAAABJRU5ErkJggg==",
  },
  {
    name: "ward-badge.png",
    sizeBytes: 6820,
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAA9klEQVR42u3buxHCQAxF0VeaqyCmDCqlAKoggwoYRr/1Sr7Bxsw9dsJa0nHcP1c+AgCA+h95Px/u0xYgEr0SQ7tHV2OoY3wmgjqGZ0Koe3wUQd3DoxCaFO9B0LR4K4ImxlsQtCr+dbOfFQjlAJ7wTIgwwJnhWRBugJ3iqxBSASrDoxBmgJ3jMxHUNT4LAYAowJnxHoS/AN3iowgAeAF2irci/ATo+vQjb4GmPH3vWwAAAAAAAAAAAAAAAAAAAMC/wcvfB3AjBAC3wnwXAIBvg3wdZj6ACRFmhJgSY06QSVFmhZkWZ1+AjRF2htgaY2+QzVF2h2efL8pTcS/O/1mkAAAAAElFTkSuQmCC",
  },
];

/** 自检钩子：`__naiwaMockWardrobeEmpty = true` 时衣柜返回空列表（验证空态文案）。 */
function mockWardrobeEmpty(): boolean {
  return (globalThis as { __naiwaMockWardrobeEmpty?: boolean }).__naiwaMockWardrobeEmpty === true;
}

/** 自检钩子：`__naiwaMockWardrobeAddFail` 是字符串时添加衣柜抛该错误原文。 */
function mockWardrobeAddFailure(): string | null {
  const message = (globalThis as { __naiwaMockWardrobeAddFail?: string }).__naiwaMockWardrobeAddFail;
  return typeof message === "string" && message ? message : null;
}

/** 自检钩子：`__naiwaMockSingleProfile = true` 时账号只有一个角色（验证单角色一行文字）。 */
function mockSingleProfile(): boolean {
  return (globalThis as { __naiwaMockSingleProfile?: boolean }).__naiwaMockSingleProfile === true;
}

/** 自检钩子：`__naiwaMockProfileFail` 是字符串时切换角色抛该错误原文。 */
function mockProfileFailure(): string | null {
  const message = (globalThis as { __naiwaMockProfileFail?: string }).__naiwaMockProfileFail;
  return typeof message === "string" && message ? message : null;
}

/**
 * 第三方站点名：主进程会从 Yggdrasil 元数据里取站点名并写进 siteName，
 * mock 没有网络，只能按域名近似（LittleSkin 直接给品牌名，其余退回域名）。
 */
function mockYggSiteName(apiUrl: string): string {
  let host = "";
  try {
    host = new URL(apiUrl).hostname.toLowerCase();
  } catch {
    return apiUrl;
  }
  if (host.endsWith("littleskin.cn")) return "LittleSkin";
  return host;
}
/** 自检钩子：`__naiwaMockImportCancel = true` 时导入返回 instanceId=null（模拟用户取消文件框）。 */
function mockImportCancelled(): boolean {
  return (globalThis as { __naiwaMockImportCancel?: boolean }).__naiwaMockImportCancel === true;
}

/** 自检钩子：`__naiwaMockImportFail` 是字符串时导入抛该错误原文。 */
function mockImportFailure(): string | null {
  const message = (globalThis as { __naiwaMockImportFail?: string }).__naiwaMockImportFail;
  return typeof message === "string" && message ? message : null;
}

/**
 * 内容类型：主进程正在实现 kind 参数，但 shared/ipc.ts 的请求类型还没带上它，
 * 这里按可选字段读，缺省当作模组（老调用方行为不变）。
 */
interface KindCarrier { kind?: ModContentKind }

function readKind(req: KindCarrier): ModContentKind {
  return req.kind ?? "mod";
}

/** 各类型的落盘目录：模组落 mods，光影/资源包/整合包各自独立目录。 */
const DIR_BY_KIND: Record<ModContentKind, string> = {
  mod: "mods",
  shader: "shaderpacks",
  resourcepack: "resourcepacks",
  modpack: "modpacks",
  map: "saves",
};

/** 报错文案里的类型名，与界面分区标题一致。 */
const KIND_LABEL: Record<ModContentKind, string> = {
  mod: "模组",
  shader: "光影包",
  resourcepack: "资源包",
  modpack: "整合包",
  map: "存档",
};

/** 各类型目录的内存态键：实例 + 类型，避免光影/资源包读到模组列表。 */
function packKey(instanceId: string, kind: ModContentKind): string {
  return `${instanceId}:${kind}`;
}

/** 某内容类型的预置文件；未收录的类型返回空列表。 */
function seedInstalled(instanceId: string, kind: ModContentKind): InstalledModInfo[] {
  if (kind === "mod") return MOCK_INSTALLED_MODS[instanceId] ?? [];
  if (kind === "shader" || kind === "resourcepack") return MOCK_INSTALLED_PACKS[kind][instanceId] ?? [];
  return [];
}

/** 某内容类型的前置样例：模组按项目查表，光影/资源包按类型给（含内置规则）。 */
function seedDependencies(
  provider: ModProviderId, projectId: string, kind: ModContentKind,
): Array<Omit<ModDependency, "installed" | "installedFileName">> {
  if (kind === "mod") return MOCK_MOD_DEPENDENCIES[`${provider}:${projectId}`] ?? [];
  if (kind === "shader" || kind === "resourcepack") return MOCK_PACK_DEPENDENCIES[kind];
  return [];
}

/** 前置自己落在哪个目录：内置光影前置是模组，其余跟随自身类型。 */
function depKind(dep: Pick<ModDependency, "kind">, fallback: ModContentKind): ModContentKind {
  return dep.kind ?? fallback;
}

/** 联机页演示用的局域网地址（预览态没有真实网卡信息）。 */
const MOCK_LAN_ADDRESSES: LanAddress[] = [
  { name: "WLAN", address: "192.168.1.23", family: "IPv4" },
  { name: "以太网", address: "10.0.0.7", family: "IPv4" },
  { name: "vEthernet (WSL)", address: "172.24.144.1", family: "IPv4" },
];

/** 樱花穿透：节点样例。第 3 个不满足「公开游戏服务器」要求（非多线），用来验证下拉里的限制标注。 */
const MOCK_FRP_NODES: { id: number; name: string; publicGameAllowed: boolean }[] = [
  { id: 1, name: "cn-1 多线", publicGameAllowed: true },
  { id: 2, name: "cn-2 多线", publicGameAllowed: true },
  { id: 3, name: "cn-3 移动", publicGameAllowed: false },
];

/** 樱花穿透：隧道样例（2 条，其中 1 条在线）。 */
const MOCK_FRP_TUNNELS: NatfrpTunnel[] = [
  {
    id: 4101, name: "NaiWa-主世界", type: "tcp", node: 1, nodeName: "cn-1 多线",
    localIp: "127.0.0.1", localPort: 25565, remote: "cn-1.frp.one:34567", online: true,
  },
  {
    id: 4102, name: "NaiWa-朋友局", type: "tcp", node: 3, nodeName: "cn-3 移动",
    localIp: "127.0.0.1", localPort: 25566, remote: "", online: false,
  },
];

/** 樱花穿透：账号样例（未签到，已连续 3 天）。 */
const MOCK_FRP_USER: NatfrpUser = {
  id: 21031,
  name: "naiwa-demo",
  email: "demo@naiwa.dev",
  groupName: "免费用户",
  trafficLeft: 12_348_440_576,
  trafficToday: 713_031_680,
  signed: false,
  signDays: 3,
};

/** 启动后分配的假公网地址：与主进程真实链路返回的形态一致。 */
const MOCK_FRP_ADDRESS = "cn-1.frp.one:34567";

/** 浏览器预览用的完整 NaiwaApi 实现：内存态 + 模拟进度事件。 */
/** 下载管理演示数据：四条记录覆盖运行中 / 已中断 / 已完成 / 失败，updatedAt 故意错开以便验证倒序。 */
function seedDownloadJobs(): DownloadJob[] {
  const base = Date.now();
  return [
    {
      id: "mock-dl-version",
      kind: "version",
      title: "Minecraft 1.21.4",
      detail: "原版 · 实例「1.21.4 原版」",
      status: "running",
      progress: 45,
      message: "正在下载 libraries（86/192）",
      createdAt: base - 8 * 60_000,
      updatedAt: base - 2_000,
    },
    {
      id: "mock-dl-loader",
      kind: "loader",
      title: "Fabric Loader 0.16.9",
      detail: "fabric · 1.21.4",
      status: "interrupted",
      progress: 30,
      message: "启动器关闭时任务还没跑完，点「继续」可以从断点接着下。",
      createdAt: base - 46 * 60_000,
      updatedAt: base - 45 * 60_000,
    },
    {
      id: "mock-dl-java",
      kind: "java",
      title: "Java 21.0.5 LTS",
      detail: "Liberica JDK · 已解压到 NaiWa/java",
      status: "done",
      progress: 100,
      message: "下载完成，已注册到本地 Java 列表。",
      createdAt: base - 3 * 3_600_000,
      updatedAt: base - 3 * 3_600_000,
    },
    {
      id: "mock-dl-content",
      kind: "content",
      title: "钠（Sodium）1.21.4",
      detail: "模组 · 实例「1.21.4 Fabric」",
      status: "failed",
      progress: 12,
      message: "下载失败：连接被重置（ECONNRESET），可点「继续」重试。",
      createdAt: base - 5 * 3_600_000,
      updatedAt: base - 5 * 3_600_000,
    },
  ];
}

export function createMockApi(): NaiwaApi {
  let settings = { ...DEFAULT_SETTINGS, activeAccountId: MOCK_ACCOUNTS[0]?.id ?? "" };
  let accounts: Account[] = MOCK_ACCOUNTS.map((item) => ({ ...item }));
  /** 设备码 → 已轮询次数：预览下前两次 pending，第三次返回新账号。 */
  const devicePolls = new Map<string, number>();
  /** 账号 id → 已应用的皮肤（上传成功后写入，恢复默认时删掉）。 */
  const appliedSkins = new Map<string, { skinUrl: string; model: "classic" | "slim" }>();
  /** 本地衣柜内存态：添加/删除后即时反映到下一次 wardrobe()。 */
  let wardrobe: WardrobeSkin[] = MOCK_WARDROBE.map((item, index) => ({
    ...item,
    updatedAt: Date.UTC(2024, 10, 1 + index, 9, 12),
  }));
  /** 本地皮肤库内存态：内置皮肤只读，用户导入可增删。 */
  let localSkins: LocalSkin[] = MOCK_LOCAL_SKINS.map((item) => ({ ...item }));
  /** 账号 id → 选中的皮肤文件名；没有记录表示跟随账号原皮肤。 */
  const skinSelection = new Map<string, string>(MOCK_ACCOUNTS.map((item) => [item.id, "steve.png"]));

  /** 按账号标记 active，渲染层据此显示「使用中」。 */
  const localSkinsFor = (accountId?: string): LocalSkin[] => {
    const picked = accountId ? skinSelection.get(accountId) ?? "" : "";
    return localSkins.map((item) => ({ ...item, active: item.fileName === picked }));
  };
  /** 账号 id → 角色列表（第一次读取时按账号播种，切换后改 active）。 */
  const profileState = new Map<string, SkinProfile[]>();
  let instances: InstanceMeta[] = MOCK_INSTANCES.map((item) => ({ ...item }));
  const installedJava: InstalledJava[] = MOCK_INSTALLED_JAVA.map((item) => ({ ...item }));

  // ---- 开服：内存态 + 日志缓冲 + 两个推送集合 + 每个服务端的假定时器 ----
  let servers: ServerEntry[] = MOCK_SERVERS.map((item) => ({ ...item, meta: { ...item.meta } }));
  const serverBuffers = new Map<string, ServerConsoleLine[]>();
  const serverLineListeners = new Set<(line: ServerConsoleLine) => void>();
  const serverStatusListeners = new Set<(entries: ServerEntry[]) => void>();
  const serverTimers = new Map<string, Array<ReturnType<typeof setTimeout>>>();

  const cloneServer = (entry: ServerEntry): ServerEntry => ({ status: entry.status, meta: { ...entry.meta } });
  const serverSnapshot = (): ServerEntry[] => servers.map(cloneServer);

  function requireServer(id: string): ServerEntry {
    const found = servers.find((item) => item.meta.id === id);
    if (!found) throw new Error(`服务端不存在：${id}`);
    return found;
  }

  function emitServers(): void {
    const snapshot = serverSnapshot();
    for (const cb of serverStatusListeners) cb(snapshot);
  }

  function pushServerLine(serverId: string, stream: ServerConsoleLine["stream"], text: string): void {
    const line: ServerConsoleLine = { serverId, at: Date.now(), stream, text };
    const buffer = serverBuffers.get(serverId) ?? [];
    buffer.push(line);
    if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
    serverBuffers.set(serverId, buffer);
    for (const cb of serverLineListeners) cb(line);
  }

  function patchServer(id: string, patch: Partial<ServerEntry["meta"]>, status?: ServerStatus): void {
    servers = servers.map((item) => (item.meta.id === id
      ? { ...item, status: status ?? item.status, meta: { ...item.meta, ...patch } }
      : item));
    emitServers();
  }

  function clearServerTimers(id: string): void {
    for (const timer of serverTimers.get(id) ?? []) clearTimeout(timer);
    serverTimers.delete(id);
  }

  function scheduleServer(id: string, ms: number, fn: () => void): void {
    const timer = setTimeout(fn, ms);
    serverTimers.set(id, [...(serverTimers.get(id) ?? []), timer]);
  }

  /** 第一次打开控制台时的假日志：按当前状态给 2-5 行（crashed 带 stderr）。 */
  function seedServerBuffer(entry: ServerEntry): void {
    const id = entry.meta.id;
    const seed: Array<{ stream: ServerConsoleLine["stream"]; text: string }> = [
      { stream: "system", text: `服务端目录：servers/${id}（${entry.meta.jarFile}）` },
      { stream: "stdout", text: `[Server thread/INFO]: Starting minecraft server version ${entry.meta.mcVersion}` },
    ];
    if (entry.status === "running") {
      seed.push({ stream: "stdout", text: "[Server thread/INFO]: Done (3.214s)! For help, type \"help\"" });
    }
    if (entry.status === "crashed") {
      seed.push({ stream: "stdout", text: "[Server thread/INFO]: Preparing level \"world\"" });
      seed.push({ stream: "stderr", text: "java.lang.OutOfMemoryError: Java heap space" });
      seed.push({ stream: "system", text: `进程异常退出（exit ${entry.meta.lastExitCode ?? 1}），可以调大内存后重试` });
    }
    serverBuffers.set(id, seed.map((line, index) => ({
      serverId: id,
      at: Date.now() - (seed.length - index) * 1200,
      stream: line.stream,
      text: line.text,
    })));
  }

  const stopServer = async (id: string): Promise<void> => {
    requireServer(id);
    clearServerTimers(id);
    patchServer(id, {}, "stopping");
    pushServerLine(id, "system", "正在保存世界并停止服务端…");
    scheduleServer(id, 900, () => {
      patchServer(id, { lastExitCode: 0 }, "stopped");
      pushServerLine(id, "stdout", "[Server thread/INFO]: 服务器已安全关闭（exit 0）");
    });
  };
  // 实例各内容目录（mods/shaderpacks/resourcepacks）的内存态：按 实例+类型 分开存，首次访问时填种子。
  const installedMods = new Map<string, InstalledModInfo[]>();
  let taskSeq = 0;
  /** 樱花穿透内存态：账号、隧道列表、节点、frpc 运行状态。 */
  const frpUser: NatfrpUser = { ...MOCK_FRP_USER };
  let frpTunnels: NatfrpTunnel[] = MOCK_FRP_TUNNELS.map((item) => ({ ...item }));
  let frpRun: { tunnelId: number; address: string } | null = null;
  let frpTunnelSeq = 4200;
  /** 下载管理内存态：操作后即时 emit，界面靠 onChanged 刷新（与主进程行为一致）。 */
  let downloadJobs: DownloadJob[] = seedDownloadJobs();
  const downloadListeners = new Set<(jobs: DownloadJob[]) => void>();

  function downloadSnapshot(): DownloadJob[] {
    return downloadJobs.map((job) => ({ ...job }));
  }

  function emitDownloads(): void {
    const snapshot = downloadSnapshot();
    downloadListeners.forEach((listener) => listener(snapshot.map((job) => ({ ...job }))));
  }

  function findDownload(id: string): DownloadJob {
    const job = downloadJobs.find((item) => item.id === id);
    if (!job) throw new Error(`下载记录不存在：${id}`);
    return job;
  }

  function patchDownload(id: string, patch: Partial<DownloadJob>): void {
    downloadJobs = downloadJobs.map((job) => (job.id === id ? { ...job, ...patch, id, updatedAt: Date.now() } : job));
  }

  /**
   * 自检钩子 `__naiwaMockDownloadsPush`：
   * 传数组 → 整表替换；传 { id, ...patch } → 改一条；不传 → 原样重发一次 onChanged。
   */
  const downloadsPush = (input?: DownloadJob[] | (Partial<DownloadJob> & { id: string })) => {
    if (Array.isArray(input)) downloadJobs = input.map((job) => ({ ...job }));
    else if (input && input.id) patchDownload(input.id, input);
    emitDownloads();
    return downloadSnapshot();
  };
  (globalThis as { __naiwaMockDownloadsPush?: typeof downloadsPush }).__naiwaMockDownloadsPush = downloadsPush;

  function frpStatus(): NatfrpStatus {
    return {
      running: Boolean(frpRun),
      tunnelId: frpRun?.tunnelId,
      address: frpRun?.address ?? "",
      log: frpRun
        ? ["[frpc] login to server success", `[frpc] tunnel started, remote ${frpRun.address}`]
        : [],
      frpcReady: true,
    };
  }

  /** 樱花穿透的三个自检开关：验证失败 / 隧道列表失败 / 签到关闭。 */
  function frpHook(name: string): boolean {
    return Boolean((globalThis as Record<string, unknown>)[name]);
  }

  function simulateTask(
    kind: TaskKind, label: string, stage: string, totalBytes: number, durationMs: number, filesTotal: number,
  ): Promise<void> {
    taskSeq += 1;
    const taskId = `mock-task-${taskSeq}`;
    const startedAt = Date.now();
    return new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const ratio = Math.min(1, (Date.now() - startedAt) / durationMs);
        const wave = 0.65 + Math.random() * 0.7;
        emitProgress({
          taskId,
          kind,
          label,
          stage,
          percent: ratio,
          downloadedBytes: Math.floor(totalBytes * ratio),
          totalBytes,
          bytesPerSecond: Math.floor((totalBytes / (durationMs / 1000)) * wave),
          filesDone: Math.floor(ratio * filesTotal),
          filesTotal,
        });
        if (ratio >= 1) {
          clearInterval(timer);
          emitDone({ taskId, kind, label, ok: true });
          resolve();
        }
      }, 140);
    });
  }

  function requireCurseforgeKey(): void {
    if (!settings.curseforgeApiKey.trim()) {
      throw new Error("CurseForge 需要 API Key：请先到「设置 → 联网与下载」填写后再搜索。");
    }
  }

  function findInstance(id: string): InstanceMeta {
    const found = instances.find((item) => item.id === id);
    if (!found) throw new Error(`实例不存在：${id}`);
    return found;
  }

  function modsOf(instanceId: string, kind: ModContentKind = "mod"): InstalledModInfo[] {
    findInstance(instanceId);
    const key = packKey(instanceId, kind);
    const existing = installedMods.get(key);
    if (existing) return existing;
    const seeded = seedInstalled(instanceId, kind).map((item) => ({ ...item }));
    installedMods.set(key, seeded);
    return seeded;
  }

  /** 假 sha1：真实实现读文件摘要，mock 里按文件名稳定派生。 */
  function mockSha1(fileName: string): string {
    let seed = 0;
    for (const char of fileName) seed = (seed * 31 + char.charCodeAt(0)) % 0xffffff;
    return seed.toString(16).padStart(6, "0").repeat(7).slice(0, 40);
  }

  function findAccount(id: string): Account {
    const found = accounts.find((item) => item.id === id);
    if (!found) throw new Error(`账号不存在：${id}`);
    return found;
  }

  /** 32 位无横线 uuid：mock 里按种子派生（LCG 展开成 32 个十六进制字符）。 */
  function mockUuid(seed: string): string {
    let state = 2166136261;
    for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
    let out = "";
    for (let index = 0; index < 32; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out += "0123456789abcdef"[state >>> 28];
    }
    return out;
  }

  /**
   * 衣柜项 → 绝对路径：renderer 给的是绝对路径就直接用；只给文件名（mock 的 data: 缩略图没有
   * 本地路径，renderer 只能退回文件名）时按衣柜目录还原。
   */
  function wardrobeFilePath(target: string): string {
    const absolute = /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\");
    return absolute ? target : MOCK_SKINS_DIR + "\\" + target.replace(/^[\\/]+/, "");
  }

  /** 角色种子：第三方账号默认两个（第二个使用中）；自检钩子可收成只剩使用中的那一个。 */
  function profilesOf(account: Account): SkinProfile[] {
    const seeded = profileState.get(account.id) ?? [
      { id: mockUuid("profile-main-" + account.uuid), name: account.name, active: false },
      { id: mockUuid("profile-alt-" + account.uuid), name: account.name + "Alt", active: true },
    ];
    profileState.set(account.id, seeded);
    if (!mockSingleProfile()) return seeded;
    return [seeded.find((item) => item.active) ?? seeded[0]];
  }
  /** 自检钩子：globalThis.__mockFail.accounts = true 时账号列表读取失败。 */
  function mockFail(scope: string): boolean {
    const flags = (globalThis as { __mockFail?: Record<string, boolean> }).__mockFail;
    return flags?.[scope] === true;
  }

  return {
    app: {
      info: async () => {
        await sleep(160);
        return { ...MOCK_APP_INFO };
      },
      openRootDir: async () => {
        console.info("[mock] 打开根目录", MOCK_ROOT);
        await sleep(80);
      },
      openInstanceMods: async (instanceId: string) => {
        console.info("[mock] 打开实例模组目录", instanceId);
        await sleep(80);
      },
      openInstanceContent: async (instanceId: string, kind: ModContentKind) => {
        console.info("[mock] 打开实例内容目录", instanceId, kind);
        await sleep(80);
      },
      openPath: async (target: string) => {
        trace("app.openPath", { path: target });
        console.info("[mock] 打开路径", target);
        await sleep(80);
        const normalized = target.replace(/\\/g, "/").replace(/\/+$/, "");
        const root = MOCK_ROOT.replace(/\\/g, "/").replace(/\/+$/, "");
        if (normalized !== root && !normalized.startsWith(`${root}/`)) {
          throw new Error(`路径不在启动器根目录内，已拒绝：${target}`);
        }
      },
      revealInFolder: async (target: string) => {
        // 与主进程一致：showItemInFolder 不受根目录守卫限制，导出到「下载」目录也能定位。
        trace("app.revealInFolder", { path: target });
        console.info("[mock] 在文件管理器中定位", target);
        await sleep(80);
      },
      openExternal: async (url: string) => {
        trace("app.openExternal", { url });
        await sleep(80);
      },
      pathExists: async (target: string) => {
        trace("app.pathExists", { path: target });
        await sleep(60);
        const normalized = target.replace(/\//g, "\\").toLowerCase();
        // 启动器自管的 NaiWa\java 目录只有已安装列表里的才视为存在，便于演示「已失效的路径」；
        // 外部 JDK 路径无法伪造，按约定含 missing/不存在 的视为已删除，其余视为存在。
        if (normalized.includes("\\naiwa\\java\\")) {
          return installedJava.some((item) => item.path.replace(/\//g, "\\").toLowerCase() === normalized);
        }
        return Boolean(target) && !/missing|不存在/i.test(target);
      },
      copyText: async (text: string) => {
        trace("app.copyText", { text });
        // 预览态没有系统剪贴板权限，用 __lastCopied 给自检脚本读取。
        (globalThis as { __lastCopied?: string }).__lastCopied = text;
        await sleep(50);
      },
      startupSound: async () => {
        trace("app.startupSound", { startupSound: settings.startupSound, startupVolume: settings.startupVolume });
        await sleep(60);
        const volume = Math.min(1, Math.max(0, settings.startupVolume));
        // 自检钩子：__naiwaMockStartupSound = false 模拟「文件不存在」，返回 null 表示启动不播放。
        const available = (globalThis as { __naiwaMockStartupSound?: boolean }).__naiwaMockStartupSound !== false;
        if (settings.startupSound === "off" || !available) return { url: null, volume };
        return { url: MOCK_STARTUP_SOUND, volume };
      },
      appIcon: async () => {
        trace("app.appIcon", { appIcon: settings.appIcon });
        await sleep(60);
        if (!settings.appIcon) return { url: null, path: null };
        // 每个文件名生成一种颜色，自检据此断言标题栏/侧边栏 img.src 真的换了。
        return {
          url: mockIconUrl(settings.appIcon),
          path: `${MOCK_DATA_ROOT}\\icons\\${settings.appIcon}`,
        };
      },
      checkUpdates: async () => {
        trace("app.checkUpdates");
        await sleep(420);
        const current = MOCK_APP_INFO.version;
        // 自检钩子：__naiwaMockUpdateError 走错误分支，__naiwaMockHasUpdate 走「有新版本」分支。
        const error = (globalThis as { __naiwaMockUpdateError?: string }).__naiwaMockUpdateError;
        if (error) return { current, latest: null, hasUpdate: false, channel: "none" as const, error };
        const hasUpdate = (globalThis as { __naiwaMockHasUpdate?: boolean }).__naiwaMockHasUpdate === true;
        if (!hasUpdate) return { current, latest: "0.1.2", hasUpdate: false, channel: "github-api" as const };
        // 自检钩子：__naiwaMockUpdateNoAsset = true 模拟「Release 里没有免安装版包」。
        const noAsset = (globalThis as { __naiwaMockUpdateNoAsset?: boolean }).__naiwaMockUpdateNoAsset === true;
        return {
          current,
          latest: "0.1.3",
          hasUpdate: true,
          url: "https://github.com/JIJIGUOWANG123/NaiWaLauncher/releases/tag/v0.1.3",
          assetUrl: noAsset
            ? undefined
            : "https://github.com/JIJIGUOWANG123/NaiWaLauncher/releases/download/v0.1.3/NaiWaLauncher.exe",
          notes: "• 下载器重做断点续传，切镜像不再丢进度\n• 存档直进支持新建世界后自动进入\n• 中文翻译增加本地缓存，命中率更高",
          publishedAt: "2026-05-18T08:00:00.000Z",
          channel: "github-api" as const,
        };
      },
      installUpdate: async (url: string) => {
        trace("app.installUpdate", { url });
        await sleep(700);
        // 自检钩子：__naiwaMockUpdateFail = true 模拟安装版（不能自替换）。
        if ((globalThis as { __naiwaMockUpdateFail?: boolean }).__naiwaMockUpdateFail === true) {
          throw new Error("当前为安装版，无法自动替换程序");
        }
        // 真机由主进程下载并替换 exe 后重启；预览下只记 trace，界面断言「正在更新…」与提示行。
        console.info("[mock] 更新包已下载", url);
      },
    },

    net: {
      interfaces: async () => {
        trace("net.interfaces");
        await sleep(140);
        // 自检钩子：__naiwaMockNetFail = true 时抛错，验证联机页的失败态与错误 toast。
        if ((globalThis as { __naiwaMockNetFail?: boolean }).__naiwaMockNetFail) {
          throw new Error("读取网卡信息失败：权限不足");
        }
        return MOCK_LAN_ADDRESSES.map((item) => ({ ...item }));
      },
      probe: async (host: string, port: number): Promise<PortProbeResult> => {
        trace("net.probe", { host, port });
        await sleep(700);
        const hooks = globalThis as {
          __naiwaMockProbeFail?: boolean;
          __naiwaMockProbeLatency?: number;
        };
        if (!host.trim()) return { ok: false, latencyMs: null, error: "请先填写地址" };
        if (hooks.__naiwaMockProbeFail) {
          return { ok: false, latencyMs: null, error: `无法连接到 ${host}:${port}（ECONNREFUSED）` };
        }
        return { ok: true, latencyMs: hooks.__naiwaMockProbeLatency ?? 42 };
      },
      portCheck: async (port: number) => {
        trace("net.portCheck", { port });
        await sleep(420);
        // 自检钩子：__naiwaMockPortListening 控制「已开房 / 未开房」两种分支。
        return Boolean((globalThis as { __naiwaMockPortListening?: boolean }).__naiwaMockPortListening);
      },
      natfrpUser: async (): Promise<NatfrpUser> => {
        trace("net.natfrpUser");
        await sleep(460);
        if (!settings.natfrpToken.trim()) {
          throw new Error("还没填写樱花穿透访问密钥：先在本页「访问密钥」里填好并保存。");
        }
        // 自检钩子：__naiwaMockFrpUserFail 模拟访问密钥失效。
        if (frpHook("__naiwaMockFrpUserFail")) {
          throw new Error("访问密钥无效或已过期（HTTP 401），请到 natfrp.com 重新复制");
        }
        // 自检钩子：__naiwaMockFrpSigned 把同一账号切成「今日已签到」分支。
        return frpHook("__naiwaMockFrpSigned") ? { ...frpUser, signed: true } : { ...frpUser };
      },
      natfrpTunnels: async () => {
        trace("net.natfrpTunnels");
        await sleep(420);
        if (!settings.natfrpToken.trim()) throw new Error("还没填写樱花穿透访问密钥");
        // 自检钩子：__naiwaMockFrpTunnelsFail 模拟列表接口 502。
        if (frpHook("__naiwaMockFrpTunnelsFail")) throw new Error("隧道列表拉取失败：natfrp.com 返回 502");
        return frpTunnels.map((item) => ({ ...item }));
      },
      natfrpNodes: async () => {
        trace("net.natfrpNodes");
        await sleep(260);
        return MOCK_FRP_NODES.map((item) => ({ ...item }));
      },
      natfrpCreate: async (name: string, node: number, localPort: number) => {
        trace("net.natfrpCreate", { name, node, localPort });
        await sleep(700);
        if (!settings.natfrpToken.trim()) throw new Error("还没填写樱花穿透访问密钥");
        if (!name.trim()) throw new Error("隧道名不能为空");
        const nodeInfo = MOCK_FRP_NODES.find((item) => item.id === node);
        if (!nodeInfo) throw new Error("节点不存在，请重新选择");
        frpTunnelSeq += 1;
        const created: NatfrpTunnel = {
          id: frpTunnelSeq, name: name.trim(), type: "tcp", node, nodeName: nodeInfo.name,
          localIp: "127.0.0.1", localPort, remote: "", online: false,
        };
        frpTunnels = [...frpTunnels, created];
        return { id: created.id, name: created.name };
      },
      natfrpStatus: async (): Promise<NatfrpStatus> => {
        trace("net.natfrpStatus");
        await sleep(80);
        return frpStatus();
      },
      natfrpStart: async (tunnelId: number): Promise<NatfrpStatus> => {
        trace("net.natfrpStart", { tunnelId });
        await sleep(900);
        if (!settings.natfrpToken.trim()) throw new Error("还没填写樱花穿透访问密钥");
        const tunnel = frpTunnels.find((item) => item.id === tunnelId);
        if (!tunnel) throw new Error(`隧道 ${tunnelId} 不存在`);
        const address = tunnel.remote || MOCK_FRP_ADDRESS;
        frpRun = { tunnelId, address };
        frpTunnels = frpTunnels.map((item) => (item.id === tunnelId ? { ...item, online: true, remote: address } : item));
        return frpStatus();
      },
      natfrpStop: async (): Promise<NatfrpStatus> => {
        trace("net.natfrpStop");
        await sleep(500);
        const stoppedId = frpRun?.tunnelId;
        frpRun = null;
        if (stoppedId !== undefined) {
          frpTunnels = frpTunnels.map((item) => (item.id === stoppedId ? { ...item, online: false } : item));
        }
        return frpStatus();
      },
    },

    media: {
      list: async () => {
        trace("media.list");
        await sleep(120);
        return {
          ...MOCK_MEDIA,
          backgrounds: [...MOCK_MEDIA.backgrounds],
          music: [...MOCK_MEDIA.music],
          icons: [...MOCK_MEDIA.icons],
          dirs: { ...MOCK_MEDIA.dirs },
        };
      },
      openDir: async (kind: "backgrounds" | "music") => {
        // 契约里还允许 "icons"，schema 尚未放开，这里按 dirs 的键取目录。
        const target = MOCK_MEDIA.dirs[kind as keyof typeof MOCK_MEDIA.dirs] ?? "";
        trace("media.openDir", { kind, dir: target });
        await sleep(80);
      },
    },

    window: {
      minimize: async () => {
        console.info("[mock] 窗口最小化");
        await sleep(20);
      },
      toggleMaximize: async () => {
        console.info("[mock] 切换最大化");
        await sleep(20);
        return false;
      },
      close: async () => {
        console.info("[mock] 关闭窗口（预览模式下不生效）");
        await sleep(20);
      },
      isMaximized: async () => false,
    },

    settings: {
      get: async () => {
        await sleep(140);
        return { ...settings };
      },
      update: async (patch) => {
        trace("settings.update", patch);
        settings = { ...settings, ...patch };
        await sleep(90);
        return { ...settings };
      },
    },

    accounts: {
      list: async () => {
        trace("accounts.list");
        if (mockFail("accounts")) throw new Error("读取账号文件失败：NaiWa/accounts.json 已损坏。");
        await sleep(200);
        return accounts.map((item) => ({ ...item }));
      },
      createOffline: async (name: string) => {
        const trimmed = name.trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(trimmed)) {
          throw new Error("昵称只能包含字母、数字和下划线，长度 3–16 位。");
        }
        if (accounts.some((item) => item.name.toLowerCase() === trimmed.toLowerCase())) {
          throw new Error(`昵称「${trimmed}」已被占用，请换一个。`);
        }
        trace("accounts.createOffline", { name: trimmed });
        await sleep(240);
        const created: Account = {
          id: `acc-${Date.now().toString(36)}`,
          type: "offline",
          name: trimmed,
          uuid: mockUuid(trimmed),
          createdAt: Date.now(),
        };
        accounts = [...accounts, created];
        return { ...created };
      },
      remove: async (id: string) => {
        trace("accounts.remove", { id });
        findAccount(id);
        await sleep(200);
        accounts = accounts.filter((item) => item.id !== id);
        if (settings.activeAccountId === id) {
          settings = { ...settings, activeAccountId: accounts[0]?.id ?? "" };
        }
      },
      setActive: async (id: string) => {
        trace("accounts.setActive", { id });
        await sleep(120);
        findAccount(id);
        accounts = accounts.map((item) => (item.id === id ? { ...item, lastUsedAt: Date.now() } : item));
        settings = { ...settings, activeAccountId: id };
      },
      loginYggdrasil: async (apiUrl: string, username: string, password: string) => {
        const trimmedUrl = apiUrl.trim();
        const trimmedUser = username.trim();
        trace("accounts.loginYggdrasil", { apiUrl: trimmedUrl, username: trimmedUser });
        await sleep(320);
        const forced = mockYggLoginError();
        if (forced) throw new Error(forced);
        if (!/^https?:\/\//i.test(trimmedUrl)) {
          throw new Error("Yggdrasil API 地址无效：需要以 http:// 或 https:// 开头。");
        }
        if (!trimmedUser || !password) throw new Error("账号或密码错误");
        const siteName = mockYggSiteName(trimmedUrl);
        const created: Account = {
          id: `acc-ygg-${Date.now().toString(36)}`,
          type: "yggdrasil",
          name: trimmedUser,
          uuid: mockUuid(`ygg-${siteName}-${trimmedUser}`),
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          yggdrasil: {
            apiUrl: trimmedUrl,
            accessToken: "mock-yggdrasil-access-token",
            clientToken: "mock-yggdrasil-client-token",
            expiresAt: 0,
            siteName,
          },
        };
        accounts = [...accounts, created];
        settings = { ...settings, activeAccountId: created.id };
        return { ...created };
      },
      validateYggdrasil: async (id: string) => {
        trace("accounts.validateYggdrasil", { id });
        await sleep(260);
        const account = findAccount(id);
        if (account.type !== "yggdrasil") throw new Error("只有第三方账号可以校验登录状态。");
        const reason = mockYggInvalidReason();
        if (reason) return { ok: false, error: reason };
        return { ok: true, name: account.name, uuid: account.uuid };
      },
      skin: async (id: string): Promise<SkinInfo> => {
        trace("accounts.skin", { id });
        const account = findAccount(id);
        await sleep(240);
        if (account.type === "offline") {
          return { source: "none", canUpload: false, error: "离线账号没有皮肤服务：先用正版或第三方账号登录。" };
        }
        const source = account.type === "microsoft" ? ("mojang" as const) : ("yggdrasil" as const);
        // 微软应用没拿到 Minecraft 服务授权时只读：预览照常给，但 canUpload=false 并说明原因。
        if (mockSkinNoUpload()) {
          return { source, skinUrl: MOCK_SKIN_TEXTURE, model: "classic", canUpload: false, error: SKIN_NO_UPLOAD_ERROR };
        }
        const applied = appliedSkins.get(id);
        return {
          source,
          skinUrl: applied?.skinUrl ?? MOCK_SKIN_TEXTURE,
          model: applied?.model ?? "classic",
          canUpload: true,
        };
      },
      pickSkinFile: async () => {
        // 自检钩子：__naiwaMockSkinPick 覆盖返回路径（指向磁盘上真实存在的图片），__naiwaMockSkinPickCancel 模拟取消。
        const overridden = (globalThis as { __naiwaMockSkinPick?: string }).__naiwaMockSkinPick;
        const picked = typeof overridden === "string" && overridden ? overridden : MOCK_SKIN_PICKED;
        const cancelled = (globalThis as { __naiwaMockSkinPickCancel?: boolean }).__naiwaMockSkinPickCancel === true;
        trace("accounts.pickSkinFile", { path: cancelled ? null : picked });
        await sleep(260);
        return cancelled ? null : picked;
      },
      uploadSkin: async (id: string, filePath: string, model: "classic" | "slim") => {
        // 记录的是真正会被上传的绝对路径：衣柜项在 mock 里只有文件名，这里按衣柜目录还原。
        trace("accounts.uploadSkin", { id, filePath: wardrobeFilePath(filePath), model });
        const account = findAccount(id);
        if (account.type === "offline") throw new Error("离线账号不支持上传皮肤。");
        if (mockSkinNoUpload()) throw new Error(SKIN_NO_UPLOAD_ERROR);
        const failure = mockSkinUploadFailure();
        if (failure) {
          await sleep(400);
          throw new Error(failure);
        }
        await sleep(700);
        appliedSkins.set(id, { skinUrl: MOCK_SKIN_TEXTURE_UPLOADED, model });
      },
      resetSkin: async (id: string) => {
        trace("accounts.resetSkin", { id });
        const account = findAccount(id);
        if (account.type === "offline") throw new Error("离线账号没有皮肤服务。");
        await sleep(520);
        if (mockSkinNoUpload()) throw new Error(SKIN_NO_UPLOAD_ERROR);
        appliedSkins.delete(id);
      },
      wardrobe: async (): Promise<WardrobeSkin[]> => {
        trace("accounts.wardrobe");
        await sleep(260);
        if (mockWardrobeEmpty()) return [];
        return wardrobe.map((item) => ({ ...item }));
      },
      addToWardrobe: async (filePath: string) => {
        trace("accounts.addToWardrobe", { filePath });
        await sleep(320);
        const failure = mockWardrobeAddFailure();
        if (failure) throw new Error(failure);
        if (!/\.png$/i.test(filePath)) throw new Error("只能添加 PNG 图片：请选择 64×64 的 PNG 皮肤文件。");
        const base = filePath.split(/[\\/]/).pop() || "skin.png";
        let name = base;
        let round = 2;
        while (wardrobe.some((item) => item.name === name)) {
          name = base.replace(/(\.[^.]+)$/, "-" + round + "$1");
          round += 1;
        }
        // mock 不落盘：新条目沿用种子缩略图，尺寸按 64×64 RGBA 记一个可信的值。
        const thumb = MOCK_WARDROBE[wardrobe.length % MOCK_WARDROBE.length];
        wardrobe = [...wardrobe, { name, url: thumb.url, sizeBytes: 64 * 64 * 4, updatedAt: Date.now() }];
        return name;
      },
      removeFromWardrobe: async (name: string) => {
        trace("accounts.removeFromWardrobe", { name });
        await sleep(240);
        if (!wardrobe.some((item) => item.name === name)) throw new Error("衣柜里没有这个文件：" + name);
        wardrobe = wardrobe.filter((item) => item.name !== name);
      },
      skinProfiles: async (id: string): Promise<SkinProfile[]> => {
        trace("accounts.skinProfiles", { id });
        await sleep(280);
        const account = findAccount(id);
        if (account.type !== "yggdrasil") return [];
        return profilesOf(account).map((item) => ({ ...item }));
      },
      selectProfile: async (id: string, profileId: string) => {
        trace("accounts.selectProfile", { id, profileId });
        await sleep(420);
        const failure = mockProfileFailure();
        if (failure) throw new Error(failure);
        const account = findAccount(id);
        if (account.type !== "yggdrasil") throw new Error("只有第三方账号可以切换角色。");
        const list = profilesOf(account);
        if (!list.some((item) => item.id === profileId)) throw new Error("角色不存在：请刷新角色列表后重试。");
        profileState.set(id, list.map((item) => ({ ...item, active: item.id === profileId })));
      },
      beginMicrosoft: async () => {
        trace("accounts.beginMicrosoft");
        await sleep(320);
        if (!settings.microsoftClientId.trim()) {
          throw new Error("请先填写 Azure 应用 client id，再发起微软登录。");
        }
        devicePolls.set("mock-device-code", 0);
        return {
          deviceCode: "mock-device-code",
          userCode: "ABCD-1234",
          verificationUri: "https://microsoft.com/link",
          expiresIn: 900,
          interval: 2,
        };
      },
      pollMicrosoft: async (deviceCode: string): Promise<MicrosoftLoginState> => {
        await sleep(200);
        // 自检钩子：globalThis.__mockPollError = "..." 时第一次轮询就按该文案失败。
        const forced = (globalThis as { __mockPollError?: string }).__mockPollError;
        if (forced) {
          trace("accounts.pollMicrosoft", { forced });
          return { status: "error", message: forced };
        }
        if (!devicePolls.has(deviceCode)) {
          return { status: "error", message: "设备码已失效，请重新发起登录。" };
        }
        const round = (devicePolls.get(deviceCode) ?? 0) + 1;
        devicePolls.set(deviceCode, round);
        trace("accounts.pollMicrosoft", { round });
        if (round <= 2) return { status: "pending" };
        if (round > 3) return { status: "error", message: "设备码已过期，请重新登录。" };
        const created: Account = {
          id: `acc-ms-${Date.now().toString(36)}`,
          type: "microsoft",
          name: `微软玩家${accounts.filter((item) => item.type === "microsoft").length + 1}`,
          uuid: mockUuid(`ms-${round}-${Date.now()}`),
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          microsoft: {
            refreshToken: "mock-refresh-token",
            accessToken: "mock-access-token",
            expiresAt: Date.now() + 3_600_000,
            xuid: "2535412345678901",
          },
        };
        accounts = [...accounts, created];
        settings = { ...settings, activeAccountId: created.id };
        return { status: "ok", account: { ...created } };
      },
    },

    sources: {
      list: async () => MOCK_SOURCES,
      probe: async () => {
        await sleep(900);
        return [
          { sourceId: "official" as const, ok: true, latencyMs: Math.round(150 + Math.random() * 120) },
          { sourceId: "bmclapi" as const, ok: true, latencyMs: Math.round(28 + Math.random() * 45) },
        ];
      },
      set: async (id) => {
        settings = { ...settings, downloadSource: id };
        await sleep(80);
        return { ...settings };
      },
    },

    versions: {
      list: async (forceRefresh) => {
        await sleep(forceRefresh ? 1000 : 420);
        return MOCK_VERSIONS;
      },
      loaders: async (mcVersion, loader) => {
        await sleep(280);
        return mockLoaderVersions(mcVersion, loader);
      },
    },

    instances: {
      list: async () => {
        await sleep(220);
        return instances.map((item) => withMockDiskUsage({ ...item }));
      },
      usage: async (id, force) => {
        trace("instances.usage", { id, force });
        await sleep(420);
        const target = findInstance(id);
        // 自检钩子：__naiwaMockUsageBytes 指定返回值，用来验证「重新统计」后的显示更新。
        const forced = (globalThis as { __naiwaMockUsageBytes?: number }).__naiwaMockUsageBytes;
        const bytes = typeof forced === "number" ? forced : (target.diskUsageBytes ?? 1024 ** 3);
        // 与主进程一致：统计结果写回实例，下一次 list 就能读到新值。
        target.diskUsageBytes = bytes;
        return { bytes };
      },
      create: async (req: CreateInstanceRequest) => {
        await simulateTask("game", `安装 Minecraft ${req.mcVersion}`, "下载游戏本体", 168_000_000, 2200, 46);
        const versionId = req.loader === "vanilla" ? req.mcVersion : `${req.mcVersion}-${req.loader}`;
        if (req.loader !== "vanilla") {
          await simulateTask("loader", `安装 ${req.loader}`, "下载加载器依赖", 24_000_000, 1500, 18);
        }
        const created: InstanceMeta = {
          id: `mock-${Date.now().toString(36)}`,
          name: req.name.trim() || `${req.mcVersion} 实例`,
          mcVersion: req.mcVersion,
          loader: req.loader,
          loaderVersion: req.loaderVersion,
          versionId,
          memoryMb: req.memoryMb ?? 4096,
          extraJvmArgs: "",
          createdAt: Date.now(),
        };
        instances = [created, ...instances];
        return { ...created };
      },
      update: async (id, patch) => {
        trace("instances.update", { id, patch });
        // 自检钩子：设置 globalThis.__naiwaMockFailInstanceUpdate = true 时写入失败，用来验证 UI 回滚。
        if ((globalThis as { __naiwaMockFailInstanceUpdate?: boolean }).__naiwaMockFailInstanceUpdate) {
          await sleep(80);
          throw new Error("模拟写入失败：实例文件被占用");
        }
        const target = findInstance(id);
        const next = { ...target, ...patch };
        instances = instances.map((item) => (item.id === id ? next : item));
        await sleep(140);
        return { ...next };
      },
      remove: async (id) => {
        findInstance(id);
        instances = instances.filter((item) => item.id !== id);
        await sleep(160);
      },
      launch: async (id, quickPlayLevel?: string) => {
        trace("instances.launch", quickPlayLevel === undefined ? { id } : { id, quickPlayLevel });
        findInstance(id);
        await simulateTask("generic", "启动游戏", "检查运行环境", 4_000_000, 900, 5);
        instances = instances.map((item) => (item.id === id ? { ...item, lastPlayedAt: Date.now() } : item));
      },
      saves: async (id) => {
        trace("instances.saves", { id });
        findInstance(id);
        await sleep(320);
        if (mockSavesFailing()) throw new Error("读取存档目录失败：模拟权限错误");
        return (MOCK_SAVES[id] ?? []).map((item) => ({ ...item }));
      },
      exportArchive: async (id) => {
        trace("instances.exportArchive", { id });
        const target = findInstance(id);
        await sleep(360);
        const failure = mockExportFailure();
        if (failure) throw new Error(failure);
        // 取消保存框：主进程返回 path=null，渲染层据此不出任何提示。
        if (mockExportCancelled()) return { path: null, name: target.name, sizeBytes: 0 };
        return { path: "D:\\备份\\示例实例-1.21.4.zip", name: target.name, sizeBytes: 12_345_678 };
      },
      importArchive: async () => {
        trace("instances.importArchive");
        await sleep(420);
        const failure = mockImportFailure();
        if (failure) throw new Error(failure);
        if (mockImportCancelled()) return { instanceId: null, name: "" };
        // 与主进程一致：导入后列表里真的多一条，刷新实例页就能看到这张新卡片。
        const imported: InstanceMeta = {
          id: "imported-1",
          name: "朋友的实例",
          mcVersion: "1.21.4",
          loader: "fabric",
          loaderVersion: "0.16.9",
          versionId: "1.21.4-fabric",
          memoryMb: 4096,
          extraJvmArgs: "",
          createdAt: Date.now(),
        };
        if (!instances.some((item) => item.id === imported.id)) {
          instances = [imported, ...instances];
        }
        return { instanceId: imported.id, name: imported.name, installedMissing: true };
      },
      setLoader: async (id: string, loader: LoaderKind, loaderVersion?: string) => {
        const target = findInstance(id);
        if (loader === "vanilla") {
          await sleep(420);
        } else {
          const label = `安装 ${loaderLabel(loader)} ${loaderVersion ?? ""}`.trim();
          await simulateTask("loader", label, "下载加载器依赖", 24_000_000, 1600, 18);
        }
        const next: InstanceMeta = {
          ...target,
          loader,
          loaderVersion: loader === "vanilla" ? undefined : (loaderVersion ?? target.loaderVersion),
          // 与主进程一致：启动版本 id 随加载器切换，模组目录不动。
          versionId: loader === "vanilla" ? target.mcVersion : `${target.mcVersion}-${loader}`,
        };
        instances = instances.map((item) => (item.id === id ? next : item));
        return { ...next };
      },
    },

    java: {
      releases: async () => {
        await sleep(520);
        return [...MOCK_JAVA_RELEASES].sort((a, b) => (b.major - a.major) || b.version.localeCompare(a.version));
      },
      installed: async () => {
        await sleep(300);
        return installedJava.map((item) => ({ ...item }));
      },
      install: async (major, version) => {
        const release = MOCK_JAVA_RELEASES.find((item) => item.major === major && item.version === version)
          ?? MOCK_JAVA_RELEASES.find((item) => item.major === major);
        if (!release) throw new Error(`BellSoft 上没有找到 Java ${major} 的可用版本`);
        await simulateTask("java", `安装 Java ${release.version}`, "下载并解压 JDK", release.sizeBytes ?? 180_000_000, 2400, 3);
        const installed: InstalledJava = {
          major: release.major,
          version: release.version,
          path: `${MOCK_DATA_ROOT}\\java\\${release.major}-${release.version}\\bin\\javaw.exe`,
          vendor: "Liberica",
        };
        const exists = installedJava.some((item) => item.major === installed.major && item.version === installed.version);
        if (!exists) installedJava.push(installed);
        return { ...installed };
      },
    },

    mods: {
      search: async (req: ModSearchRequest) => {
        const kind = readKind(req);
        // 光影/资源包/整合包在预览里只有麦块社区（中文）源；模组按来源或「所有来源」合并。
        const source: ModSourceFilter = req.source ?? (kind === "mod" ? req.provider : "minekuai");
        // 自检脚本按这条 trace 断言筛选条件真的进了请求，所以版本/加载器/排序也一并记下。
        trace("mods.search", {
          source, query: req.query, kind, gameVersion: req.gameVersion ?? null, loader: req.loader ?? null,
          category: req.category ?? null, resolution: req.resolution ?? null, sort: req.sort ?? null,
        });
        if (source === "curseforge") requireCurseforgeKey();
        await sleep(480);
        const query = req.query.trim().toLowerCase();
        const wanted = [req.category, req.resolution]
          .map((value) => value?.trim().toLowerCase() ?? "")
          .filter((value) => value.length > 0);
        const matched = MOCK_CONTENT[kind]
          .filter((mod) => source === "all" || mod.provider === source)
          .filter((mod) => wanted.every((id) => mod.categories.some((category) => category.toLowerCase() === id)))
          .filter((mod) => query.length === 0
            || mod.title.toLowerCase().includes(query)
            || (mod.titleZh ?? "").includes(query)
            || mod.slug.includes(query)
            || mod.description.toLowerCase().includes(query)
            || (mod.summaryZh ?? "").includes(query)
            || mod.categories.some((category) => category.toLowerCase().includes(query)))
          // 版本/更新时间的筛选用元数据：真实链路由主进程按来源站补齐，mock 从这里派生。
          .map((mod) => ({ ...mod, ...(MOCK_CONTENT_META[mod.projectId] ?? {}) }));
        if (source !== "all") {
          const offset = req.offset ?? 0;
          const limit = req.limit ?? 20;
          return matched.slice(offset, offset + limit);
        }
        // 「所有来源」：同 projectId 去重（保留中文名，下载量取大）后按热度降序，最多 40 条。
        const byProject = new Map<string, ModSearchResult>();
        for (const item of matched) {
          const seen = byProject.get(item.projectId);
          if (!seen) {
            byProject.set(item.projectId, item);
            continue;
          }
          const base = !seen.titleZh && item.titleZh ? item : seen;
          const other = base === seen ? item : seen;
          byProject.set(item.projectId, {
            ...base,
            titleZh: base.titleZh ?? other.titleZh,
            summaryZh: base.summaryZh ?? other.summaryZh,
            iconUrl: base.iconUrl ?? other.iconUrl,
            downloads: Math.max(seen.downloads, item.downloads),
          });
        }
        return [...byProject.values()].sort((a, b) => b.downloads - a.downloads).slice(0, 40);
      },
      categories: async (kind: ModContentKind, source: ModSourceFilter) => {
        trace("mods.categories", { kind, source });
        await sleep(160);
        const seen = new Map<string, ModCategory>();
        for (const item of MOCK_CONTENT[kind] ?? []) {
          if (source !== "all" && item.provider !== source) continue;
          for (const id of item.categories) {
            if (!seen.has(id)) seen.set(id, { id, name: id });
          }
        }
        return [...seen.values()];
      },
      filterOptions: async (kind: ModContentKind) => {
        trace("mods.filterOptions", { kind });
        await sleep(160);
        const options: ModFilterOptions = {
          versions: MOCK_VERSIONS.map((version) => version.id),
          loaders: kind === "mod" || kind === "modpack" ? ["fabric", "forge", "neoforge", "quilt", "liteloader"] : [],
          resolutions: kind === "resourcepack" || kind === "shader"
            ? ["16x", "32x", "48x", "64x", "128x", "256x", "512x"]
            : [],
        };
        return options;
      },
      detail: async (provider: ModProviderId, projectId: string) => {
        trace("mods.detail", { provider, projectId });
        const project = mockFindProject(projectId);
        if (!project || project.provider !== provider) throw new Error(`未找到项目：${projectId}`);
        await sleep(320);
        return { ...mockDetailFor(project) };
      },
      files: async (req: ModFilesRequest) => {
        const kind = readKind(req);
        trace("mods.files", { projectId: req.projectId, kind });
        if (req.provider === "curseforge") requireCurseforgeKey();
        // minekuai 的 projectId 就是 Modrinth ID，按 projectId 反查即可沿用 Modrinth 那一套文件数据。
        const project = mockFindProject(req.projectId);
        if (!project) throw new Error(`未找到项目：${req.projectId}`);
        await sleep(420);
        return mockFiles(project, req.gameVersion ?? "", req.loader === "vanilla" ? "" : (req.loader ?? ""), kind);
      },
      dependencies: async (
        provider: ModProviderId, projectId: string, instanceId: string, fileId?: string, kind: ModContentKind = "mod",
      ) => {
        trace("mods.dependencies", { provider, projectId, instanceId, fileId: fileId ?? null, kind });
        const instance = findInstance(instanceId);
        if (mockDepsFailing()) {
          await sleep(180);
          throw new Error("前置查询失败：模拟网络错误");
        }
        await sleep(280);
        return seedDependencies(provider, projectId, kind).map((dep) => {
          // 前置按自己的类型查目录：光影的内置前置是模组，已装与否要看 mods。
          const hit = modsOf(instance.id, depKind(dep, kind)).find((item) => item.projectId === dep.projectId);
          return { ...dep, installed: Boolean(hit), installedFileName: hit?.fileName };
        });
      },
      maps: async (query: string, page: number, instanceId?: string) => {
        trace("mods.maps", { query, page, instanceId: instanceId ?? null });
        await sleep(420);
        const keyword = query.trim().toLowerCase();
        const matched = MOCK_MAPS.filter((entry) => keyword.length === 0
          || entry.title.toLowerCase().includes(keyword)
          || entry.description.toLowerCase().includes(keyword)
          || entry.category.toLowerCase().includes(keyword)
          || entry.author.toLowerCase().includes(keyword));
        const mcVersion = instanceId ? findInstance(instanceId).mcVersion : undefined;
        const pageSize = 20;
        const start = Math.max(0, (page - 1) * pageSize);
        return matched.slice(start, start + pageSize).map((entry) => ({
          ...entry,
          // 主进程按实例版本标注适配性；没有实例时不判定，界面也不显示徽标。
          compatible: mcVersion
            ? entry.versions.some((version) => version.replace(/^v/i, "") === mcVersion)
            : undefined,
        }));
      },
      installModpack: async (provider: ModProviderId, projectId: string, fileId?: string, instanceName?: string) => {
        // 自检按这条 trace 断言渲染层传对了 provider/projectId/fileId。
        trace("mods.installModpack", {
          provider, projectId, fileId: fileId ?? null, instanceName: instanceName ?? null,
        });
        if ((globalThis as { __naiwaMockFailModpack?: boolean }).__naiwaMockFailModpack) {
          await sleep(260);
          throw new Error("模拟创建实例失败：磁盘空间不足");
        }
        const project = mockFindProject(projectId);
        if (!project) throw new Error(`未找到项目：${projectId}`);
        const meta = MOCK_CONTENT_META[projectId] ?? {};
        await simulateTask("game", `安装整合包 ${project.title}`, "下载整合包", 96_000_000, 2600, 24);
        // 与主进程一致：实例名默认取整合包名（有中文名时用中文名）。
        const name = (instanceName ?? "").trim() || project.titleZh || project.title;
        const created: InstanceMeta = {
          id: `mock-pack-${Date.now().toString(36)}`,
          name,
          mcVersion: meta.versions?.[0] ?? "1.20.1",
          loader: (meta.loaders?.[0] as LoaderKind | undefined) ?? "fabric",
          versionId: `${meta.versions?.[0] ?? "1.20.1"}-${meta.loaders?.[0] ?? "fabric"}`,
          memoryMb: 4096,
          extraJvmArgs: "",
          createdAt: Date.now(),
        };
        instances = [created, ...instances];
        await sleep(200);
        return { instanceId: created.id, name: created.name };
      },
      install: async (req: ModInstallRequest) => {
        const project = mockFindProject(req.projectId);
        if (!project) throw new Error(`未找到项目：${req.projectId}`);
        const kind = readKind(req);
        const withDeps = req.installDependencies === true;
        trace("mods.install", {
          projectId: req.projectId,
          fileId: req.fileId ?? null,
          instanceId: req.instanceId,
          kind,
          installDependencies: withDeps,
        });
        const files = mockFiles(project, "", "", kind);
        const target = files.find((file) => file.fileId === req.fileId) ?? files[0];
        const instance = findInstance(req.instanceId);
        await simulateTask("mod", `安装 ${project.title}`, "下载模组文件", 12_000_000, 1200, 1);
        const path = `${MOCK_GAME_ROOT}\\instances\\${instance.id}\\${DIR_BY_KIND[kind]}\\${target.fileName}`;
        /** 连带安装的前置：按前置自己的目录判断缺失，只补必需的。 */
        const installedDependencies: string[] = [];
        if (withDeps) {
          for (const dep of seedDependencies(project.provider, project.projectId, kind)) {
            if (!dep.required) continue;
            const depTarget = depKind(dep, kind);
            const depList = modsOf(instance.id, depTarget);
            if (depList.some((item) => item.projectId === dep.projectId)) continue;
            const fileName = mockDependencyFile(dep.slug ?? dep.projectId);
            installedMods.set(packKey(instance.id, depTarget), [...depList, {
              fileName,
              sizeBytes: 1_200_000,
              sha1: mockSha1(fileName),
              name: dep.nameZh ?? dep.name,
              version: "1.20.1",
              provider: dep.provider,
              projectId: dep.projectId,
              update: null,
            }]);
            installedDependencies.push(dep.nameZh ?? dep.name ?? dep.projectId);
          }
        }
        const installed: InstalledModInfo = {
          fileName: target.fileName,
          sizeBytes: 4_800_000,
          sha1: mockSha1(target.fileName),
          name: project.title,
          version: target.gameVersions[0],
          provider: project.provider,
          projectId: project.projectId,
          update: null,
        };
        // 模组/光影/资源包各落各的目录；整合包与存档不算进这三类列表。
        if (kind === "mod" || kind === "shader" || kind === "resourcepack") {
          // 目录可能刚被前置写过，重读一次拿到最新状态。
          const current = modsOf(instance.id, kind);
          installedMods.set(packKey(instance.id, kind), [
            ...current.filter((item) => item.fileName !== target.fileName),
            installed,
          ]);
        }
        return { fileName: target.fileName, path, installedDependencies };
      },
      /**
       * 已装内容索引：直接从三个内容目录的内存态派生，install/remove/update 改完状态即生效，
       * 浏览器预览里点安装后角标马上跟着变。
       */
      installedContent: async (instanceId: string) => {
        trace("mods.installedContent", { instanceId });
        await sleep(160);
        const kinds: ModContentKind[] = ["mod", "shader", "resourcepack"];
        const refs: InstalledContentRef[] = [];
        for (const contentKind of kinds) {
          for (const item of modsOf(instanceId, contentKind)) {
            if (!item.provider || !item.projectId) continue;
            refs.push({
              provider: item.provider,
              projectId: item.projectId,
              kind: contentKind,
              fileName: item.fileName,
              // mock 只记了版本标签，真实实现给的是站点那边的 versionId。
              versionId: item.version,
              source: "index",
            });
          }
        }
        // 磁盘扫描兜底：没有索引的老文件/手工放进去的资源，projectId 为空串，
        // 只能靠 modId/文件名主干做弱匹配——这正是事故现场那种实例的形态。
        for (const extra of MOCK_SCANNED_CONTENT[instanceId] ?? []) {
          refs.push({ ...extra });
        }
        return refs;
      },
      installed: async (instanceId: string, kind: ModContentKind = "mod") => {
        trace("mods.installed", { instanceId, kind });
        await sleep(260);
        return modsOf(instanceId, kind).map((item) => ({ ...item }));
      },
      checkUpdates: async (instanceId: string, kind: ModContentKind = "mod") => {
        trace("mods.checkUpdates", { instanceId, kind });
        await sleep(900);
        // 真实实现按 sha1 逐个反查远端；mock 用预置目录模拟，命中项才带 update。
        const known = kind === "mod" ? MOCK_MOD_UPDATES : MOCK_PACK_UPDATES;
        const checked = modsOf(instanceId, kind).map((item) => ({ ...item, update: known[item.fileName] ?? null }));
        installedMods.set(packKey(instanceId, kind), checked);
        return checked.map((item) => ({ ...item }));
      },
      remove: async (instanceId: string, fileName: string, kind: ModContentKind = "mod") => {
        trace("mods.remove", { instanceId, fileName, kind });
        await sleep(240);
        const list = modsOf(instanceId, kind);
        if (!list.some((item) => item.fileName === fileName)) {
          throw new Error(`${KIND_LABEL[kind]}不存在：${fileName}`);
        }
        installedMods.set(packKey(instanceId, kind), list.filter((item) => item.fileName !== fileName));
      },
      update: async (instanceId: string, fileName: string, kind: ModContentKind = "mod") => {
        trace("mods.update", { instanceId, fileName, kind });
        const instance = findInstance(instanceId);
        const list = modsOf(instanceId, kind);
        const target = list.find((item) => item.fileName === fileName);
        if (!target) throw new Error(`${KIND_LABEL[kind]}不存在：${fileName}`);
        if (!target.update) throw new Error(`${fileName} 没有可用更新`);
        await simulateTask("mod", `更新 ${target.name ?? fileName}`, "下载新版本", 12_000_000, 1200, 1);
        const next: InstalledModInfo = {
          ...target,
          fileName: target.update.fileName,
          version: target.update.versionLabel,
          sizeBytes: target.sizeBytes + 65_536,
          update: null,
        };
        installedMods.set(packKey(instanceId, kind), list.map((item) => (item.fileName === fileName ? next : item)));
        return {
          fileName: next.fileName,
          path: `${MOCK_GAME_ROOT}\\instances\\${instance.id}\\${DIR_BY_KIND[kind]}\\${next.fileName}`,
        };
      },
    },

    downloads: {
      list: async () => {
        trace("downloads.list", { count: downloadJobs.length });
        await sleep(160);
        return downloadSnapshot();
      },
      resume: async (id: string) => {
        const job = findDownload(id);
        trace("downloads.resume", { id, from: job.status, progress: job.progress });
        await sleep(220);
        patchDownload(id, { status: "running", message: "已继续下载，正在重新连接源站…" });
        emitDownloads();
      },
      cancel: async (id: string) => {
        const job = findDownload(id);
        trace("downloads.cancel", { id, progress: job.progress });
        await sleep(180);
        // 主进程已在做真正的传输中断：mock 也把状态放到 cancelled（UI 显示「已终止」，可继续）。
        patchDownload(id, { status: "cancelled", message: "任务已终止，进度已保留，可点「继续」接着下。" });
        emitDownloads();
      },
      remove: async (id: string) => {
        findDownload(id);
        trace("downloads.remove", { id });
        await sleep(140);
        downloadJobs = downloadJobs.filter((job) => job.id !== id);
        emitDownloads();
      },
      clearFinished: async () => {
        const done = downloadJobs.filter((job) => job.status === "done").length;
        trace("downloads.clearFinished", { removed: done });
        await sleep(140);
        downloadJobs = downloadJobs.filter((job) => job.status !== "done");
        emitDownloads();
      },
      onChanged: (cb) => {
        downloadListeners.add(cb);
        return () => { downloadListeners.delete(cb); };
      },
    },

    skinsLocal: {
      list: async (accountId?: string) => {
        trace("skinsLocal.list", { accountId: accountId ?? null });
        await sleep(180);
        return localSkinsFor(accountId);
      },
      select: async (accountId: string, fileName: string | null) => {
        trace("skinsLocal.select", { accountId, fileName });
        await sleep(120);
        if (fileName === null) {
          skinSelection.delete(accountId);
        } else {
          if (!localSkins.some((item) => item.fileName === fileName)) {
            throw new Error(`皮肤库里没有这个文件：${fileName}`);
          }
          skinSelection.set(accountId, fileName);
        }
        return localSkinsFor(accountId);
      },
      import: async (filePaths: string[]) => {
        trace("skinsLocal.import", { count: filePaths.length, filePaths });
        await sleep(320);
        const imported: string[] = [];
        const skipped: string[] = [];
        for (const target of filePaths) {
          const fileName = target.split(/[\\/]/).pop() || "skin.png";
          if (!/\.png$/i.test(fileName) || localSkins.some((item) => item.fileName === fileName)) {
            skipped.push(fileName);
            continue;
          }
          localSkins = [...localSkins, {
            fileName,
            name: fileName.replace(/\.png$/i, ""),
            source: "user",
            path: MOCK_SKIN_TEXTURE_UPLOADED,
            sizeBytes: 64 * 64 * 4,
            width: 64,
            height: 64,
            model: "classic",
            active: false,
          }];
          imported.push(fileName);
        }
        return { imported, skipped };
      },
      remove: async (fileName: string) => {
        trace("skinsLocal.remove", { fileName });
        await sleep(220);
        const target = localSkins.find((item) => item.fileName === fileName);
        if (!target) throw new Error(`皮肤库里没有这个文件：${fileName}`);
        if (target.source === "official") throw new Error("内置皮肤不能删除");
        localSkins = localSkins.filter((item) => item.fileName !== fileName);
        for (const [accountId, picked] of skinSelection) {
          if (picked === fileName) skinSelection.delete(accountId);
        }
        return localSkinsFor();
      },
      applyToInstance: async (instanceId: string, accountId: string) => {
        trace("skinsLocal.applyToInstance", { instanceId, accountId });
        await sleep(420);
        const picked = skinSelection.get(accountId);
        if (!picked) {
          return { applied: false, modInstalled: true, message: "这个账号还没有选中本地皮肤。" };
        }
        // 预览里故意返回 modInstalled:false，方便点验「一键安装 CustomSkinLoader」分支。
        return {
          applied: true,
          modInstalled: false,
          skinFile: picked,
          message: `已把 ${picked} 写进实例；还差 CustomSkinLoader 才会在游戏里生效。`,
        };
      },
      ensureMod: async (instanceId: string) => {
        trace("skinsLocal.ensureMod", { instanceId });
        await simulateTask("mod", "安装 CustomSkinLoader", "下载模组文件", 1_200_000, 900, 1);
        return { installed: true, fileName: "CustomSkinLoader_Universal-15.0.5.jar" };
      },
      pathForFile: (file: File) => `${MOCK_SKINS_DIR}\\${file?.name || "skin.png"}`,
    },

    servers: {
      cores: async () => {
        trace("servers.cores");
        await sleep(200);
        return MOCK_SERVER_CORES.map((item) => ({ ...item, mcVersions: [...item.mcVersions] }));
      },
      builds: async (core: ServerCoreId, mcVersion: string) => {
        trace("servers.builds", { core, mcVersion });
        await sleep(240);
        return mockServerBuilds(core, mcVersion);
      },
      list: async () => {
        trace("servers.list");
        await sleep(160);
        return serverSnapshot();
      },
      create: async (req: ServerCreateRequest) => {
        trace("servers.create", req);
        await simulateTask("generic", `下载 ${req.core} ${req.coreVersion}`, "下载服务端 jar", 48_000_000, 1400, 1);
        const id = `srv-${Date.now().toString(36)}`;
        const entry: ServerEntry = {
          status: "stopped",
          meta: {
            id,
            name: req.name.trim() || `${req.core} ${req.mcVersion}`,
            core: req.core,
            mcVersion: req.mcVersion,
            coreVersion: req.coreVersion,
            jarFile: `${req.core.toLowerCase()}-${req.mcVersion}.jar`,
            port: req.port ?? 25565,
            memoryMb: req.memoryMb ?? 2048,
            maxPlayers: req.maxPlayers ?? 20,
            onlineMode: req.onlineMode ?? true,
            eulaAgreed: true,
            createdAt: Date.now(),
          },
        };
        servers = [...servers, entry];
        serverBuffers.set(id, [{
          serverId: id,
          at: Date.now(),
          stream: "system",
          text: `已写入 eula.txt（eula=true）与 server.properties（端口 ${entry.meta.port}，最大人数 ${entry.meta.maxPlayers}）`,
        }]);
        emitServers();
        return cloneServer(entry);
      },
      remove: async (id: string) => {
        trace("servers.remove", { id });
        requireServer(id);
        await sleep(180);
        clearServerTimers(id);
        servers = servers.filter((item) => item.meta.id !== id);
        serverBuffers.delete(id);
        emitServers();
      },
      update: async (id: string, patch) => {
        trace("servers.update", { id, patch });
        const current = requireServer(id);
        const next = { ...current.meta, ...patch };
        if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) {
          throw new Error("端口需要是 1-65535 的整数");
        }
        if (!Number.isInteger(next.memoryMb) || next.memoryMb < 512) throw new Error("内存至少 512 MB");
        await sleep(160);
        patchServer(id, patch);
        return cloneServer(requireServer(id));
      },
      start: async (id: string) => {
        trace("servers.start", { id });
        const entry = requireServer(id);
        if (entry.status === "running" || entry.status === "starting") return cloneServer(entry);
        clearServerTimers(id);
        patchServer(id, {}, "starting");
        pushServerLine(id, "system", `正在启动 ${entry.meta.core} ${entry.meta.coreVersion}（${entry.meta.memoryMb} MB，端口 ${entry.meta.port}）`);
        scheduleServer(id, 500, () => {
          pushServerLine(id, "stdout", `[Server thread/INFO]: Starting minecraft server version ${entry.meta.mcVersion}`);
        });
        scheduleServer(id, 1200, () => {
          pushServerLine(id, "stdout", "[Server thread/INFO]: Preparing level \"world\"");
        });
        scheduleServer(id, 1900, () => {
          patchServer(id, { lastStartedAt: Date.now(), lastExitCode: undefined }, "running");
          pushServerLine(id, "stdout", "[Server thread/INFO]: Done (3.214s)! For help, type \"help\"");
        });
        return cloneServer(requireServer(id));
      },
      stop: async (id: string) => {
        trace("servers.stop", { id });
        await stopServer(id);
        return cloneServer(requireServer(id));
      },
      command: async (id: string, line: string) => {
        trace("servers.command", { id, line });
        const entry = requireServer(id);
        if (entry.status !== "running") throw new Error("服务端没在运行，命令发不出去");
        const trimmed = line.trim().replace(/^\//, "");
        if (!trimmed) return;
        pushServerLine(id, "system", `> ${trimmed}`);
        if (trimmed === "stop" || trimmed === "end") {
          await stopServer(id);
          return;
        }
        pushServerLine(id, "stdout", `[Server thread/INFO]: 已执行 ${trimmed}`);
      },
      console: async (id: string, limit = 500) => {
        trace("servers.console", { id, limit });
        const entry = requireServer(id);
        await sleep(120);
        if (!serverBuffers.has(id)) seedServerBuffer(entry);
        const buffer = serverBuffers.get(id) ?? [];
        return buffer.slice(Math.max(0, buffer.length - limit)).map((line) => ({ ...line }));
      },
      onConsole: (cb: (line: ServerConsoleLine) => void) => {
        serverLineListeners.add(cb);
        return () => { serverLineListeners.delete(cb); };
      },
      onStatus: (cb: (entries: ServerEntry[]) => void) => {
        serverStatusListeners.add(cb);
        return () => { serverStatusListeners.delete(cb); };
      },
    },

    events: {
      onProgress: (cb) => {
        mockBus.progress.add(cb);
        return () => { mockBus.progress.delete(cb); };
      },
      onTaskDone: (cb) => {
        mockBus.done.add(cb);
        return () => { mockBus.done.delete(cb); };
      },
      onLog: (cb) => {
        mockBus.log.add(cb);
        return () => { mockBus.log.delete(cb); };
      },
    },
  };
}