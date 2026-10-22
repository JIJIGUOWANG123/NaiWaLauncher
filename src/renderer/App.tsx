import { useEffect, useRef } from "react";
import { AppProvider, useApp } from "./lib/store";
import { TaskProvider } from "./lib/tasks";
import { ToastProvider } from "./components/Toast";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { TaskPanel } from "./components/TaskPanel";
import { InstancesPage } from "./pages/InstancesPage";
import { AccountsPage } from "./pages/AccountsPage";
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
import { backgroundUrl, musicUrl } from "./lib/media";
import { useBackgroundPlayback } from "./lib/background";
import { attachAudio, pauseMusic, playMusic, setMusicVolume } from "./lib/music";
import { playStartupSound, stopStartupSound } from "./lib/startupSound";
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
  const media = useAsync(() => api.media.list(), []);
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
  const bgUrl = backgroundUrl(media.data, playback.name);

  return (
    <div className="app-frame">
      <div
        className={`app-bg ${bgUrl ? "has-image" : ""} ${playback.fading ? "is-fading" : ""}`.trim()}
        style={bgUrl ? { backgroundImage: `url("${bgUrl}")` } : undefined}
        aria-hidden="true"
      />

      <TitleBar
        style={titleBar}
        text={settings?.titleBarText ?? ""}
        backgroundDir={media.data?.dirs.backgrounds ?? ""}
        backgroundName={playback.name}
      />

      <div className="app-shell">
        <Sidebar />
        <main className="content">
          {page === "instances" ? <InstancesPage /> : null}
          {page === "accounts" ? <AccountsPage /> : null}
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
