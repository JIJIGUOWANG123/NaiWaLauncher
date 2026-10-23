import { useEffect, useRef, useState } from "react";
import { AppProvider, useApp } from "./lib/store";
import { TaskProvider } from "./lib/tasks";
import { ToastProvider } from "./components/Toast";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { TaskPanel } from "./components/TaskPanel";
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
import { backgroundUrl, isVideoFile, musicUrl } from "./lib/media";
import { useBackgroundPlayback } from "./lib/background";
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
  // 背景图播放（单张 / 顺序轮播 / 随机轮播）由设置驱动，改间隔即时生效。
  const playback = useBackgroundPlayback(
    media.data,
    settings?.backgroundImage ?? "",
    settings?.backgroundMode ?? "single",
    settings?.backgroundIntervalSec ?? 20,
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const musicName = settings?.backgroundMusic ?? "";
  const musicSource = musicUrl(media.data, musicName);
  const volume = settings?.musicVolume ?? 0.5;
  // 视频背景音量（0–1，默认 0 = 静音）：0 时把 <video> 直接 muted，否则用 ref 设 volume。
  const bgVideoVolume = Math.min(1, Math.max(0, settings?.backgroundVideoVolume ?? 0));
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const bgUrl = backgroundUrl(media.data, playback.name);
  // 背景资源里可能是图片也可能是视频：按文件类型分流，轮播逻辑不变（换的只是 playback.name）。
  const bgIsVideo = isVideoFile(playback.name) || isVideoFile(bgUrl);

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
        backgroundName={bgIsVideo ? "" : playback.name}
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
        <TaskPanel />
      </div>

      <audio ref={audioRef} className="bg-audio" src={musicSource || undefined} loop preload="auto" />
    </div>
  );
}
