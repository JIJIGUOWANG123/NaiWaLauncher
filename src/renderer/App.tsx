import { useCallback, useEffect, useRef, useState } from "react";
import { AppProvider, useApp } from "./lib/store";
import { TaskProvider } from "./lib/tasks";
import { ToastProvider, useToast } from "./components/Toast";
import { Sidebar } from "./components/Sidebar";
import { LaunchFailureDialog } from "./components/LaunchFailureDialog";
import { TitleBar } from "./components/TitleBar";
import { InstancesPage } from "./pages/InstancesPage";
import { AccountsPage } from "./pages/AccountsPage";
import { SkinPage } from "./pages/SkinPage";
import { ServerPage } from "./pages/ServerPage";
import { DownloadPage } from "./pages/DownloadPage";
import { DownloadsPage } from "./pages/DownloadsPage";
import { ModsPage } from "./pages/ModsPage";
import { NetPage } from "./pages/NetPage";
import { JavaPage } from "./pages/JavaPage";
import { PersonalizePage } from "./pages/PersonalizePage";
import { LaunchSettingsPage } from "./pages/LaunchSettingsPage";
import { OtherSettingsPage } from "./pages/OtherSettingsPage";
import { AboutPage } from "./pages/AboutPage";
import { SettingsPage } from "./pages/SettingsPage";
import { api } from "./lib/api";
import { iconSrc } from "./lib/appIcon";
import { backgroundUrl, isVideoFile, mediaUrl, musicUrl } from "./lib/media";
import { clampInterval, useBackgroundPlayback } from "./lib/background";
import type { BackgroundMode, DownloadJob } from "../shared/types";
import type { LaunchDiagnosisEvent } from "../shared/ipc";
import { attachAudio, pauseMusic, playMusic, setMusicVolume } from "./lib/music";
import { playStartupSound, stopStartupSound } from "./lib/startupSound";
import { afterFirstFrame, perfMark, perfTime } from "./lib/perf";
import { applyTheme } from "./lib/theme";
import { useT } from "./lib/i18n";
import { useAsync } from "./lib/useAsync";

export function App() {
  return (
    <ToastProvider>
      <TaskProvider>
        <AppProvider>
          <Shell />
        </AppProvider>
      </TaskProvider>
    </ToastProvider>
  );
}

/** 下载提示的聚合窗口：窗口期内同一状态的任务合并成一条提示。 */
const DL_TOAST_WINDOW_MS = 500;

type DlToastKind = "started" | "done" | "failed";

/** 一个窗口期内同一状态的合并结果。 */
export interface DlToastBatch {
  kind: DlToastKind;
  count: number;
  /** 首个任务的标题：只有 1 个时用它，多个时改走计数文案。 */
  title: string;
}

/**
 * 500ms 聚合窗口：第一个事件开窗，窗口结束时把收集到的状态合成一批交出去。
 * 优先级 failed > done > started：同一窗口里既有完成又有失败时只报失败，避免重要信息被合并盖掉。
 */
export function createDlToastBatcher(onFlush: (batch: DlToastBatch) => void, windowMs = DL_TOAST_WINDOW_MS) {
  const pending = new Map<DlToastKind, { count: number; title: string }>();
  let timer: number | undefined;
  const flush = () => {
    timer = undefined;
    const kind = (["failed", "done", "started"] as const).find((candidate) => pending.has(candidate));
    if (!kind) return;
    const batch = pending.get(kind)!;
    pending.clear();
    onFlush({ kind, count: batch.count, title: batch.title });
  };
  return {
    add(kind: DlToastKind, title: string) {
      const current = pending.get(kind);
      if (current) current.count += 1;
      else pending.set(kind, { count: 1, title });
      // 固定窗口（不随新事件重置），这样长批次也能按 500ms 节奏持续汇报
      if (timer === undefined) timer = window.setTimeout(flush, windowMs);
    },
    dispose() {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}

/** 合并结果 → toast 的文案 / 语气 / 自检属性（data-dl-toast-state 用 started/done/failed）。 */
export function dlToastContent(
  batch: DlToastBatch,
  tr: (key: string, vars?: Record<string, string | number>) => string,
) {
  const many = batch.count > 1;
  const key = batch.kind === "started"
    ? (many ? "pages.dlToast.startedCount" : "pages.dlToast.started")
    : batch.kind === "done"
      ? (many ? "pages.dlToast.doneCount" : "pages.dlToast.done")
      : (many ? "pages.dlToast.failedCount" : "pages.dlToast.failed");
  const tone: "success" | "error" | "info" =
    batch.kind === "done" ? "success" : batch.kind === "failed" ? "error" : "info";
  return {
    message: tr(key, { title: batch.title, n: batch.count }),
    tone,
    data: {
      "data-dl-toast": "",
      "data-dl-toast-state": batch.kind,
      "data-dl-toast-count": String(batch.count),
    },
  };
}

function Shell() {
  const { page, booted, settings, iconUrl, navigate, updatePhase } = useApp();
  const { push: pushToast } = useToast();
  const tr = useT();
  // 背景层与标题栏图片都要用 dirs，外壳自己拉一次媒体列表。
  // 它只影响背景图/背景音乐这类装饰，延后到首帧之后再要，别和 boot 的 IPC 抢时间。
  const [mediaReady, setMediaReady] = useState(false);
  useEffect(() => {
    afterFirstFrame(() => setMediaReady(true));
  }, []);
  const media = useAsync(async () => (mediaReady ? perfTime("media-list", api.media.list()) : null), [mediaReady]);

  // 背景的开关与播放参数（要在 useBackgroundPlayback 之前算好）：
  // 总开关 backgroundEnabled × 当前来源自己的开关，任一为关就整层不渲染。
  const bgSource = settings?.backgroundSource ?? "local";
  const sourceEnabled = bgSource === "api"
    ? settings?.backgroundApiEnabled ?? true
    : bgSource === "wallpaperEngine"
      ? settings?.backgroundWallpaperEnabled ?? true
      : settings?.backgroundLocalEnabled ?? true;
  const bgActive = (settings?.backgroundEnabled ?? true) && sourceEnabled;
  // 本地与壁纸引擎各有自己的播放方式/间隔；API 来源用 apiBackground*。
  const localMode: BackgroundMode = bgSource === "wallpaperEngine"
    ? settings?.wallpaperBackgroundMode ?? "single"
    : settings?.backgroundMode ?? "single";
  const localInterval = bgSource === "wallpaperEngine"
    ? settings?.wallpaperBackgroundIntervalSec ?? 20
    : settings?.backgroundIntervalSec ?? 20;

  // 壁纸引擎来源的播放池：进入该来源时懒加载一次（切换来源不重复请求）。
  // 以前 sequence/random 只认本地背景目录，壁纸引擎下永远在轮播本地图片（用户反馈的问题）。
  const [wallpaperPool, setWallpaperPool] = useState<string[]>([]);
  const wallpaperLoaded = useRef(false);
  useEffect(() => {
    if (bgSource !== "wallpaperEngine" || wallpaperLoaded.current) return;
    wallpaperLoaded.current = true;
    void api.wallpaper
      .list()
      .then((entries) => {
        // 视频壁纸用视频、静态图壁纸用图片；两者都没有的条目跳过
        setWallpaperPool(entries.map((item) => item.videoPath || item.imagePath).filter((path) => path.length > 0));
      })
      .catch(() => {
        // 读失败允许下次切回该来源再试；池子为空时自动退回本地行为
        wallpaperLoaded.current = false;
      });
  }, [bgSource]);

  // 「每次启动随机一张」：三套字段互不影响；API 来源不走播放池，单独在下面处理。
  const startupRandomKey = bgSource === "local"
    ? (settings?.backgroundStartupRandom === true ? "local" : undefined)
    : bgSource === "wallpaperEngine"
      ? (settings?.wallpaperBackgroundStartupRandom === true ? "wallpaperEngine" : undefined)
      : undefined;

  // 背景图播放（单张 / 顺序轮播 / 随机轮播）由设置驱动，改间隔即时生效；关闭时不参与轮播。
  // 壁纸引擎来源把「壁纸文件列表」当播放池交给 hook，本地来源照旧用背景目录里的文件。
  const playback = useBackgroundPlayback(
    media.data,
    bgActive ? (settings?.backgroundImage ?? "") : "",
    bgActive ? localMode : "single",
    localInterval,
    bgSource === "wallpaperEngine" ? wallpaperPool : undefined,
    bgActive ? startupRandomKey : undefined,
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const musicName = settings?.backgroundMusic ?? "";
  const musicSource = musicUrl(media.data, musicName);
  const volume = settings?.musicVolume ?? 0.5;
  // 视频背景音量（0–1，默认 0 = 静音）：0 时把 <video> 直接 muted，否则用 ref 设 volume。
  const bgVideoVolume = Math.min(1, Math.max(0, settings?.backgroundVideoVolume ?? 0));
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);

  // local 与 wallpaperEngine 都用 settings.backgroundImage（文件名或绝对路径）；
  // api 模式完全忽略 backgroundImage，改成向主进程要一张随机图。
  // 两层开关任意一层关掉时，API 来源也一次请求都不发。
  const apiUrl = (settings?.backgroundApiUrl ?? "").trim();
  const apiRequested = bgSource === "api" && bgActive;
  const apiMode = apiRequested && apiUrl !== "";
  const [apiBg, setApiBg] = useState<{ url: string; kind: "image" | "video" } | null>(null);
  const apiPending = useRef(false);

  const loadApiBackground = useCallback(async () => {
    if (apiPending.current) return;
    apiPending.current = true;
    try {
      const next = await api.media.apiBackground();
      if (next) setApiBg({ url: next.url, kind: next.kind });
    } catch {
      // 拉失败沿用上一张；个性化页里有明确的失败提示，这里不重复打扰。
    } finally {
      apiPending.current = false;
    }
  }, []);

  // API 来源的「每次启动随机一张」：本次进程里只在首次进入时拉一张新图，
  // 之后切走再切回来沿用同一张（不再重随机）；关掉时保持原来的「每次进入都拉一张」。
  const apiStartupRandom = settings?.apiBackgroundStartupRandom === true;
  const apiStartupDone = useRef(false);

  // 进入 API 模式先拉一张；个性化页的「立即换一张」会把新地址写进 backgroundImage，
  // 这里只把它当刷新信号（API 模式不按 backgroundImage 显示）。
  useEffect(() => {
    if (!apiMode) {
      // 开了启动随机就保留这张图，切回来还是它；没开则清掉，回来时重新拉
      if (!apiStartupRandom) setApiBg(null);
      return;
    }
    if (apiStartupRandom) {
      if (apiStartupDone.current) return;
      apiStartupDone.current = true;
    }
    void loadApiBackground();
  }, [apiMode, apiStartupRandom, loadApiBackground, settings?.backgroundImage]);

  // API 模式轮播：single 只由「立即换一张」驱动，sequence / random 按 apiBackgroundIntervalSec 换新图。
  const apiMode2 = settings?.apiBackgroundMode ?? "single";
  const apiInterval = settings?.apiBackgroundIntervalSec ?? 20;
  useEffect(() => {
    if (!apiMode) return;
    if (apiMode2 === "single") return;
    const timer = setInterval(() => void loadApiBackground(), clampInterval(apiInterval) * 1000);
    return () => clearInterval(timer);
  }, [apiInterval, apiMode, apiMode2, loadApiBackground]);

  const bgUrl = apiRequested
    ? (apiMode && apiBg ? mediaUrl("", apiBg.url) : "")
    : (bgActive ? backgroundUrl(media.data, playback.name) : "");
  // 背景资源里可能是图片也可能是视频：按文件类型分流，轮播逻辑不变（换的只是 playback.name）。
  const bgIsVideo = apiMode
    ? apiBg?.kind === "video"
    : (isVideoFile(playback.name) || isVideoFile(bgUrl));

  // 下载提示：开始 / 完成 / 失败都在右上角浮一条，带「查看」直接跳「管理」页。
  // 一次安装会瞬间创建几十个任务，所以按 500ms 窗口合并：同一窗口内只弹一条，
  // 多个时文案改用计数（「开始下载 5 个文件」）；失败优先级最高，合并不会盖掉失败。
  // slot 固定为 "download"：同一时间只有一条，新的直接顶掉旧的（不叠加），也不阻塞任何操作。
  const jobStatuses = useRef(new Map<string, DownloadJob["status"]>());
  useEffect(() => {
    const batcher = createDlToastBatcher((batch) => {
      const { message, tone, data } = dlToastContent(batch, tr);
      pushToast(
        message,
        tone,
        { label: tr("pages.dlToast.view"), onClick: () => navigate("downloads"), data: { "data-action": "dl-toast-view" } },
        { placement: "top-right", durationMs: 3500, slot: "download", data },
      );
    });
    // 先把磁盘上已有的任务记成基线：重启后恢复的记录只补记状态，不补弹「开始下载」。
    void api.downloads
      .list()
      .then((jobs) => {
        for (const job of jobs) {
          if (!jobStatuses.current.has(job.id)) jobStatuses.current.set(job.id, job.status);
        }
      })
      .catch(() => {
        // 读失败就不做基线，宁可多弹一条合并提示，也不能漏掉真正的开始/失败
      });
    const off = api.downloads.onChanged((jobs) => {
      const seen = jobStatuses.current;
      const next = new Map<string, DownloadJob["status"]>();
      for (const job of jobs) {
        next.set(job.id, job.status);
        const previous = seen.get(job.id);
        // 基线之后才出现的任务就是「开始下载」；基线里的老任务只补记状态
        if (previous === undefined) {
          batcher.add("started", job.title);
          continue;
        }
        if (previous === job.status) continue;
        if (job.status === "running") batcher.add("started", job.title);
        else if (job.status === "done") batcher.add("done", job.title);
        else if (job.status === "failed") batcher.add("failed", job.title);
      }
      jobStatuses.current = next;
    });
    return () => {
      batcher.dispose();
      off();
    };
  }, [navigate, pushToast, tr]);

  // 主进程推送的更新阶段：检查/下载/安装在后台跑，这里只用右上角 toast 交代进度（不阻塞、不弹对话框）
  useEffect(() => {
    if (!updatePhase) return;
    const version = updatePhase.latest ?? "";
    if (updatePhase.phase === "downloading") {
      pushToast(tr("upd.toast.downloading", { version }), "info", undefined, {
        placement: "top-right",
        durationMs: 6000,
        slot: "update",
        data: { "data-upd-toast": "", "data-upd-toast-state": "downloading" },
      });
    } else if (updatePhase.phase === "deferred") {
      pushToast(tr("upd.toast.deferred"), "info", undefined, {
        placement: "top-right",
        durationMs: 9000,
        slot: "update",
        data: { "data-upd-toast": "", "data-upd-toast-state": "deferred" },
      });
    } else if (updatePhase.phase === "applied") {
      pushToast(tr("upd.toast.applied", { version }), "success", undefined, {
        placement: "top-right",
        durationMs: 8000,
        slot: "update",
        data: { "data-upd-toast": "", "data-upd-toast-state": "applied" },
      });
    }
  }, [updatePhase, pushToast, tr]);

  // 启动失败诊断弹窗：按实例 id 去重排队，一次只弹一条，多个实例同时崩溃时不会连弹
  const [launchFailures, setLaunchFailures] = useState<LaunchDiagnosisEvent[]>([]);
  useEffect(() => {
    return api.events.onGameDiagnosis((event) => {
      setLaunchFailures((prev) => (prev.some((item) => item.instanceId === event.instanceId) ? prev : [...prev, event]));
    });
  }, []);

  // 首屏：booted 之后这一次 commit 就是用户看到的第一帧主界面
  useEffect(() => {
    if (!booted) return;
    perfMark("first-commit");
    const frame = window.requestAnimationFrame(() => perfMark("first-paint"));
    return () => window.cancelAnimationFrame(frame);
  }, [booted]);

  useEffect(() => {
    if (settings) applyTheme(settings);
  }, [settings]);

  useEffect(() => {
    attachAudio(audioRef.current);
    return () => attachAudio(null);
  });

  useEffect(() => {
    setMusicVolume(volume);
  }, [volume, musicSource]);

  // 换视频（轮播到下一段）或改音量都要重新赋一次：<video> 的 muted/volume 不会被 React 自动带过去。
  useEffect(() => {
    const element = bgVideoRef.current;
    if (!element) return;
    element.volume = bgVideoVolume;
    element.muted = bgVideoVolume === 0;
  }, [bgUrl, bgVideoVolume]);

  // 启动音效：主界面出现（boot 完成）后播一次；切页面不重播，卸载时停止。
  useEffect(() => {
    if (!booted) return;
    void playStartupSound();
    return () => stopStartupSound();
  }, [booted]);

  useEffect(() => {
    if (!musicSource) {
      pauseMusic();
      return;
    }
    // 启动/换曲即尝试播放；被浏览器自动播放策略拦下时静默，按钮显示「播放」。
    void playMusic();
  }, [musicSource]);

  if (!booted) {
    return (
      <div className="boot-screen">
        <img
          className="boot-logo"
          src={iconSrc(iconUrl)}
          alt=""
          width={64}
          height={64}
          data-app-icon={iconUrl ? "custom" : "default"}
        />
        <strong className="boot-title">NaiWa Launcher</strong>
        <span className="boot-hint">奶娃启动器 · 正在读取本地配置…</span>
        <span className="spinner" aria-hidden="true" />
      </div>
    );
  }

  const titleBar = settings?.titleBar ?? "compact";

  return (
    <div className="app-frame">
      <div
        className={`app-bg ${bgUrl ? "has-image" : ""} ${playback.fading ? "is-fading" : ""}`.trim()}
        data-bg-kind={bgUrl ? (bgIsVideo ? "video" : "image") : "none"}
        style={bgUrl && !bgIsVideo ? { backgroundImage: `url("${bgUrl}")` } : undefined}
        aria-hidden="true"
      >
        {bgIsVideo ? (
          // key 跟着地址走：轮播换到下一段视频时重新挂载，从头播放。
          <video
            key={bgUrl}
            ref={bgVideoRef}
            className="app-bg-video"
            src={bgUrl}
            autoPlay
            muted={bgVideoVolume === 0}
            loop
            playsInline
            preload="auto"
            data-bg-video-volume={bgVideoVolume}
            aria-hidden="true"
          />
        ) : null}
      </div>

      <TitleBar
        style={titleBar}
        text={settings?.titleBarText ?? ""}
        backgroundDir={media.data?.dirs.backgrounds ?? ""}
        // 标题栏的「图片」样式只能吃图片：当前是视频时不传名字，让它回退到主题底色，
        // 免得塞一个 .mp4 给 background-image（那只会渲染成空白）。
        backgroundName={apiRequested || bgIsVideo ? "" : playback.name}
      />

      <div className="app-shell">
        <Sidebar />
        <main className="content">
          {page === "instances" ? <InstancesPage /> : null}
          {page === "servers" ? <ServerPage /> : null}
          {page === "accounts" ? <AccountsPage /> : null}
          {page === "skins" ? <SkinPage /> : null}
          {page === "download" ? <DownloadPage /> : null}
          {page === "downloads" ? <DownloadsPage /> : null}
          {page === "mods" ? <ModsPage /> : null}
          {page === "net" ? <NetPage /> : null}
          {page === "java" ? <JavaPage /> : null}
          {page === "personalize" ? <PersonalizePage /> : null}
          {page === "launch" ? <LaunchSettingsPage /> : null}
          {page === "other" ? <OtherSettingsPage /> : null}
          {page === "about" ? <AboutPage /> : null}
          {page === "settings" ? <SettingsPage /> : null}
        </main>
      </div>

      <audio ref={audioRef} className="bg-audio" src={musicSource || undefined} loop preload="auto" />

      <LaunchFailureDialog event={launchFailures[0] ?? null} onClose={() => setLaunchFailures((prev) => prev.slice(1))} />
    </div>
  );
}
