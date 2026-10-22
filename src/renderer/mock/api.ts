import type {
  CreateInstanceRequest, ModFilesRequest, ModInstallRequest, ModSearchRequest, ModSourceFilter, NaiwaApi,
} from "../../shared/ipc";
import type {
  Account, DownloadJob, InstalledModInfo, InstanceMeta, InstalledJava, LanAddress, LoaderKind, MapEntry,
  MicrosoftLoginState, ModCategory, ModContentKind, ModFilterOptions, ModProviderId, ModSearchResult,
  NatfrpStatus, NatfrpTunnel, NatfrpUser, PortProbeResult, TaskKind,
} from "../../shared/types";
import { loaderLabel } from "../lib/format";
import {
  DEFAULT_SETTINGS, MOCK_ACCOUNTS, MOCK_APP_INFO, MOCK_INSTALLED_JAVA, MOCK_INSTALLED_MODS, MOCK_INSTANCES,
  MOCK_JAVA_RELEASES, MOCK_DATA_ROOT, MOCK_GAME_ROOT, MOCK_CONTENT, MOCK_CONTENT_META, MOCK_MAPS, MOCK_MEDIA,
  MOCK_MOD_DEPENDENCIES,
  MOCK_MOD_UPDATES, MOCK_ROOT, MOCK_SAVES, MOCK_SOURCES, MOCK_STARTUP_SOUND, MOCK_VERSIONS,
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
  let instances: InstanceMeta[] = MOCK_INSTANCES.map((item) => ({ ...item }));
  const installedJava: InstalledJava[] = MOCK_INSTALLED_JAVA.map((item) => ({ ...item }));
  // 实例 mods 目录的内存态：首次访问时用种子数据填充。
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

  function modsOf(instanceId: string): InstalledModInfo[] {
    findInstance(instanceId);
    const existing = installedMods.get(instanceId);
    if (existing) return existing;
    const seeded = (MOCK_INSTALLED_MODS[instanceId] ?? []).map((item) => ({ ...item }));
    installedMods.set(instanceId, seeded);
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
        return {
          current,
          latest: "0.1.3",
          hasUpdate: true,
          url: "https://github.com/wanglaoji123/NaiWaLauncher/releases/tag/v0.1.3",
          notes: "• 下载器重做断点续传，切镜像不再丢进度\n• 存档直进支持新建世界后自动进入\n• 中文翻译增加本地缓存，命中率更高",
          publishedAt: "2026-05-18T08:00:00.000Z",
          channel: "github-api" as const,
        };
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
        return instances.map((item) => ({ ...item }));
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
      dependencies: async (provider: ModProviderId, projectId: string, instanceId: string, fileId?: string) => {
        trace("mods.dependencies", { provider, projectId, instanceId, fileId: fileId ?? null });
        const instance = findInstance(instanceId);
        if (mockDepsFailing()) {
          await sleep(180);
          throw new Error("前置查询失败：模拟网络错误");
        }
        await sleep(280);
        const deps = MOCK_MOD_DEPENDENCIES[`${provider}:${projectId}`] ?? [];
        const installed = modsOf(instance.id);
        return deps.map((dep) => {
          const hit = installed.find((item) => item.projectId === dep.projectId);
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
      install: async (req: ModInstallRequest) => {
        const project = mockFindProject(req.projectId);
        if (!project) throw new Error(`未找到项目：${req.projectId}`);
        const kind = readKind(req);
        const withDeps = kind === "mod" && req.installDependencies === true;
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
        /** 连带安装的前置：按当前 mods 目录判断缺失，只补必需的。 */
        const installedDependencies: string[] = [];
        let list = modsOf(instance.id);
        if (withDeps) {
          for (const dep of MOCK_MOD_DEPENDENCIES[`${project.provider}:${project.projectId}`] ?? []) {
            if (!dep.required) continue;
            if (list.some((item) => item.projectId === dep.projectId)) continue;
            const fileName = mockDependencyFile(dep.slug ?? dep.projectId);
            list = [...list, {
              fileName,
              sizeBytes: 1_200_000,
              sha1: mockSha1(fileName),
              name: dep.nameZh ?? dep.name,
              version: "1.20.1",
              provider: dep.provider,
              projectId: dep.projectId,
              update: null,
            }];
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
        // 光影/资源包/整合包落在各自目录，不算进实例的 mods 列表。
        if (kind === "mod") {
          installedMods.set(instance.id, [...list.filter((item) => item.fileName !== target.fileName), installed]);
        }
        return { fileName: target.fileName, path, installedDependencies };
      },
      installed: async (instanceId: string) => {
        await sleep(260);
        return modsOf(instanceId).map((item) => ({ ...item }));
      },
      checkUpdates: async (instanceId: string) => {
        await sleep(900);
        // 真实实现按 sha1 逐个反查远端；mock 用预置目录模拟，命中项才带 update。
        const checked = modsOf(instanceId).map((item) => ({ ...item, update: MOCK_MOD_UPDATES[item.fileName] ?? null }));
        installedMods.set(instanceId, checked);
        return checked.map((item) => ({ ...item }));
      },
      remove: async (instanceId: string, fileName: string) => {
        await sleep(240);
        const list = modsOf(instanceId);
        if (!list.some((item) => item.fileName === fileName)) throw new Error(`模组不存在：${fileName}`);
        installedMods.set(instanceId, list.filter((item) => item.fileName !== fileName));
      },
      update: async (instanceId: string, fileName: string) => {
        const instance = findInstance(instanceId);
        const list = modsOf(instanceId);
        const target = list.find((item) => item.fileName === fileName);
        if (!target) throw new Error(`模组不存在：${fileName}`);
        if (!target.update) throw new Error(`${fileName} 没有可用更新`);
        await simulateTask("mod", `更新 ${target.name ?? fileName}`, "下载新版本", 12_000_000, 1200, 1);
        const next: InstalledModInfo = {
          ...target,
          fileName: target.update.fileName,
          version: target.update.versionLabel,
          sizeBytes: target.sizeBytes + 65_536,
          update: null,
        };
        installedMods.set(instanceId, list.map((item) => (item.fileName === fileName ? next : item)));
        return { fileName: next.fileName, path: `${MOCK_GAME_ROOT}\\instances\\${instance.id}\\mods\\${next.fileName}` };
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