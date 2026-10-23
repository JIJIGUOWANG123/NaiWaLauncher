import { useCallback, useEffect, useRef, useState } from "react";
import { AppProvider, useApp } from "./lib/store";
import { TaskProvider } from "./lib/tasks";
import { ToastProvider } from "./components/Toast";
import { Sidebar } from "./components/Sidebar";
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
import type { BackgroundMode } from "../shared/types";
import { attachAudio, pauseMusic, playMusic, setMusicVolume } from "./lib/music";
import { playStartupSound, stopStartupSound } from "./lib/startupSound";
import { afterFirstFrame, perfMark, perfTime } from "./lib/perf";
import { applyTheme } from "./lib/theme";
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

function Shell() {
  const { page, booted, settings, iconUrl } = useApp();
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
    </div>
  );
}
