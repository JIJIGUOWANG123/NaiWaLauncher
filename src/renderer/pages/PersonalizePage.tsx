import { useEffect, useRef, useState } from "react";
import type { ApiBackground, BackgroundMode, Settings, ThemeId, TitleBarStyle, WallpaperEntry } from "../../shared/types";
import { api } from "../lib/api";
import { useApp } from "../lib/store";
import { usePersist } from "../lib/persist";
import { iconSrc, openIconsDir } from "../lib/appIcon";
import { isVideoFile, mediaLabel, mediaUrl } from "../lib/media";
import { pauseMusic, playMusic, setMusicVolume, useMusicState } from "../lib/music";
import { playPreviewSound, stopPreviewSound } from "../lib/startupSound";
import {
  THEME_PRESETS, accentOf, applyTheme, applyUiOpacity, derivedGradEnd, isHexColor, readBgTint, writeBgTint,
} from "../lib/theme";
import { BACKGROUND_INTERVAL_MAX, BACKGROUND_INTERVAL_MIN, clampInterval } from "../lib/background";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { Field, Select, Slider, TextInput, Toggle } from "../components/Form";
import { ErrorState, LoadingState } from "../components/State";
import { IconFolder, IconPause, IconPlay, IconRefresh } from "../components/icons";
import logo from "../assets/logo.png";

/** 系统标题栏已移除：只剩「精简」与「图片」两种自绘外观。 */
const TITLE_BARS: Array<{ value: TitleBarStyle; label: string; hint: string }> = [
  { value: "compact", label: "精简", hint: "40px 主题渐变细条，随主题色变化" },
  { value: "image", label: "图片", hint: "当前背景图做条底 + 半透明遮罩 + 主题色描边" },
];

/** 背景来源三选：本地目录 / API 随机图 / Steam 壁纸引擎。 */
const BG_SOURCES: Array<{ value: Settings["backgroundSource"]; label: string }> = [
  { value: "local", label: "本地背景图" },
  { value: "api", label: "API 随机图" },
  { value: "wallpaperEngine", label: "Steam 壁纸引擎" },
];

/** API 随机图的示例地址：只当 placeholder 灰字提示，永远不写进设置、也不会被请求。 */
const API_BG_PLACEHOLDER = "https://example.com/api/random?size=1920x1080";

const BACKGROUND_MODES: Array<{ value: BackgroundMode; label: string }> = [
  { value: "single", label: "单张" },
  { value: "sequence", label: "顺序轮播" },
  { value: "random", label: "随机轮播" },
];

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/** 滑杆填充色跟随主题（Form.Slider 内部写死了 --amber，这里用 --accent）。 */
const trackFill = (ratio: number): string =>
  `linear-gradient(90deg, var(--accent) ${ratio * 100}%, color-mix(in srgb, var(--text) 14%, transparent) ${ratio * 100}%)`;

export function PersonalizePage() {
  const { settings, iconUrl, reloadIcon } = useApp();
  const { push } = useToast();
  const persist = usePersist();
  const media = useAsync(() => api.media.list(), []);
  // Steam 壁纸引擎：读主进程扫描出的 <Steam 库>\steamapps\workshop\content\431960 下的视频壁纸
  const wallpapers = useAsync<WallpaperEntry[]>(() => api.wallpaper.list(), []);
  const music = useMusicState();
  const [opacity, setOpacity] = useState<number>(settings?.uiOpacity ?? 1);
  const [volume, setVolume] = useState<number>(settings?.musicVolume ?? 0.5);
  const [startupVolume, setStartupVolume] = useState<number>(settings?.startupVolume ?? 0.6);
  const [previewing, setPreviewing] = useState<boolean>(false);
  const [tint, setTint] = useState<boolean>(readBgTint);
  const [colorDraft, setColorDraft] = useState<string>(settings?.accentColor ?? "#E0A93B");
  const [titleDraft, setTitleDraft] = useState<string>(settings?.titleBarText ?? "");
  const [gradFromDraft, setGradFromDraft] = useState<string>(settings?.gradientFrom ?? "");
  const [gradToDraft, setGradToDraft] = useState<string>(settings?.gradientTo ?? "");
  const [intervalDraft, setIntervalDraft] = useState<string>(String(settings?.backgroundIntervalSec ?? 20));
  // 视频背景音量草稿（0–100，落盘时除 100）：拖动时只改本地，松手才写设置。
  const [videoVolumeDraft, setVideoVolumeDraft] = useState<number>(Math.round((settings?.backgroundVideoVolume ?? 0) * 100));

  useEffect(() => {
    if (settings) setOpacity(settings.uiOpacity);
  }, [settings?.uiOpacity]);

  useEffect(() => {
    if (settings) setVolume(settings.musicVolume);
  }, [settings?.musicVolume]);

  useEffect(() => {
    if (settings) setStartupVolume(settings.startupVolume);
  }, [settings?.startupVolume]);

  // 离开个性化页就要停掉试听，避免它和启动音效/背景音乐一起响。
  useEffect(() => () => stopPreviewSound(), []);

  useEffect(() => {
    if (settings) setColorDraft(settings.accentColor);
  }, [settings?.accentColor]);

  useEffect(() => {
    if (settings) setTitleDraft(settings.titleBarText);
  }, [settings?.titleBarText]);

  useEffect(() => {
    if (settings) setGradFromDraft(settings.gradientFrom);
  }, [settings?.gradientFrom]);

  useEffect(() => {
    if (settings) setGradToDraft(settings.gradientTo);
  }, [settings?.gradientTo]);

  const openDir = async (kind: "backgrounds" | "music", label: string) => {
    try {
      await api.media.openDir(kind);
      push(`已打开${label}文件夹`, "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const refreshMedia = () => {
    media.reload();
    push("已重新读取背景图片与背景音乐列表", "info");
  };

  const openIconFolder = async () => {
    try {
      await openIconsDir();
      push("已打开界面图标文件夹", "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const refreshIcons = () => {
    media.reload();
    push("已重新读取 NaiWa/icons 列表", "info");
  };

  // 图标换完要显式让主进程重算 file:// 直链，标题栏/侧边栏才会即时换图。
  const pickIcon = async (value: string) => {
    const saved = await persist({ appIcon: value }, value ? `界面图标（${value}）` : "界面图标（已改回内置 logo）");
    if (saved) await reloadIcon();
  };

  // 拖动时先改 CSS 变量做实时预览，松手/松键才落盘。
  const previewOpacity = (value: number) => {
    setOpacity(value);
    applyUiOpacity(value);
  };
  const commitOpacity = () => void persist({ uiOpacity: opacity }, "界面不透明度");

  const previewVolume = (value: number) => {
    setVolume(value);
    setMusicVolume(value);
  };
  const commitVolume = () => void persist({ musicVolume: volume }, "背景音乐音量");

  const pickTheme = (id: ThemeId) => {
    if (id === "custom") {
      void persist({ theme: "custom", accentColor: colorDraft }, "自定义主题色");
      return;
    }
    void persist({ theme: id }, "主题色");
  };

  const previewAccent = (value: string) => {
    const next = value.toUpperCase();
    setColorDraft(next);
    applyTheme({
      theme: "custom",
      accentColor: next,
      uiOpacity: opacity,
      customGradient: settings?.customGradient === true,
      gradientFrom: gradFromDraft,
      gradientTo: gradToDraft,
    });
  };
  const commitAccent = () => void persist({ theme: "custom", accentColor: colorDraft }, "自定义主题色");

  /** 拖动渐变色时先用当前设置 + 草稿色实时预览，松手才落盘。 */
  const previewGradient = (from: string, to: string) => {
    applyTheme({
      theme: settings?.theme ?? "custom",
      accentColor: colorDraft,
      uiOpacity: opacity,
      customGradient: settings?.customGradient === true,
      gradientFrom: from,
      gradientTo: to,
    });
  };
  const previewFrom = (value: string) => {
    const next = value.toUpperCase();
    setGradFromDraft(next);
    previewGradient(next, gradToDraft);
  };
  const previewTo = (value: string) => {
    const next = value.toUpperCase();
    setGradToDraft(next);
    previewGradient(gradFromDraft, next);
  };
  const commitFrom = () => {
    if ((settings?.gradientFrom ?? "").toUpperCase() === gradFromDraft.toUpperCase()) return;
    void persist({ gradientFrom: gradFromDraft }, "渐变起始色");
  };
  const commitTo = () => {
    if ((settings?.gradientTo ?? "").toUpperCase() === gradToDraft.toUpperCase()) return;
    void persist({ gradientTo: gradToDraft }, "渐变结束色");
  };
  /** 清空为 ""：回到「跟随主题」的推导配色。 */
  const followTheme = (side: "from" | "to") => {
    if (side === "from") {
      setGradFromDraft("");
      previewGradient("", gradToDraft);
      void persist({ gradientFrom: "" }, "渐变起始色（跟随主题）");
      return;
    }
    setGradToDraft("");
    previewGradient(gradFromDraft, "");
    void persist({ gradientTo: "" }, "渐变结束色（跟随主题）");
  };

  const toggleTint = (value: boolean) => {
    setTint(value);
    writeBgTint(value);
  };

  const pickBackground = (value: string) =>
    void persist({ backgroundImage: value }, value ? "背景图片" : "背景图片（已关闭）");

  const pickMusic = (value: string) =>
    void persist({ backgroundMusic: value }, value ? "背景音乐" : "背景音乐（已关闭）");

  const pickStartupSound = (value: string) =>
    void persist(
      { startupSound: value },
      value === "off" ? "启动音效（已关闭）" : value ? "启动音效" : "启动音效（内置默认 bgm）",
    );

  const commitStartupVolume = () => void persist({ startupVolume }, "启动音效音量");

  // ---- API 随机图：默认关闭（backgroundApiUrl 为空就是关闭，绝不发请求）----
  const bgSource = settings?.backgroundSource ?? "local";
  const apiUrl = (settings?.backgroundApiUrl ?? "").trim();
  const apiEnabled = bgSource === "api" && apiUrl !== "";
  const [apiUrlDraft, setApiUrlDraft] = useState(settings?.backgroundApiUrl ?? "");
  const [apiBg, setApiBg] = useState<ApiBackground | null>(null);
  const [apiRolling, setApiRolling] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const apiAutoRef = useRef(false);

  /** 某个来源自己的开关：分段仍可切换用于配置，真正渲染与否看它 + 总开关。 */
  const sourceEnabled = (source: Settings["backgroundSource"]): boolean => (
    source === "api"
      ? settings?.backgroundApiEnabled ?? true
      : source === "wallpaperEngine"
        ? settings?.backgroundWallpaperEnabled ?? true
        : settings?.backgroundLocalEnabled ?? true
  );

  /** 当前来源对应的播放方式 / 间隔：三套字段互不干扰。 */
  const playbackMode: BackgroundMode = bgSource === "api"
    ? settings?.apiBackgroundMode ?? "single"
    : bgSource === "wallpaperEngine"
      ? settings?.wallpaperBackgroundMode ?? "single"
      : settings?.backgroundMode ?? "single";
  const playbackInterval = bgSource === "api"
    ? settings?.apiBackgroundIntervalSec ?? 20
    : bgSource === "wallpaperEngine"
      ? settings?.wallpaperBackgroundIntervalSec ?? 20
      : settings?.backgroundIntervalSec ?? 20;

  const setPlaybackMode = (value: BackgroundMode) => {
    if (bgSource === "api") {
      void persist({ apiBackgroundMode: value }, "API 随机图播放方式");
      return;
    }
    if (bgSource === "wallpaperEngine") {
      void persist({ wallpaperBackgroundMode: value }, "壁纸引擎播放方式");
      return;
    }
    void persist({ backgroundMode: value }, "背景图片播放方式");
  };

  const setPlaybackInterval = (value: number) => {
    if (bgSource === "api") {
      void persist({ apiBackgroundIntervalSec: value }, "API 随机图轮播间隔");
      return;
    }
    if (bgSource === "wallpaperEngine") {
      void persist({ wallpaperBackgroundIntervalSec: value }, "壁纸引擎轮播间隔");
      return;
    }
    void persist({ backgroundIntervalSec: value }, "背景轮播间隔");
  };

  // 间隔草稿跟着「当前来源」的间隔走（切换来源就换成那一套字段）。
  useEffect(() => {
    if (settings) setIntervalDraft(String(playbackInterval));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackInterval]);

  useEffect(() => {
    setApiUrlDraft(settings?.backgroundApiUrl ?? "");
  }, [settings?.backgroundApiUrl]);

  const commitApiUrl = () => {
    const next = apiUrlDraft.trim();
    if (next === (settings?.backgroundApiUrl ?? "")) return;
    void persist({ backgroundApiUrl: next }, next ? "API 随机图地址" : "API 随机图地址（已清空，相当于关闭）");
  };

  /** 拉一张随机图：writeSettings=false 只更新本页预览（进入模式时用），按钮传 true 顺便记成当前背景。 */
  const rollApiBackground = async (writeSettings = true) => {
    if (!apiUrl) {
      setApiError("还没有填写地址：API 随机图相当于关闭");
      return;
    }
    setApiRolling(true);
    setApiError(null);
    try {
      const next = await api.media.apiBackground();
      if (!next) {
        setApiError("接口没有返回可用的图片地址（主进程返回空）");
        return;
      }
      setApiBg(next);
      if (writeSettings) await persist({ backgroundImage: next.url }, "API 随机背景");
    } catch (error: unknown) {
      setApiError(errorMessage(error));
    } finally {
      setApiRolling(false);
    }
  };

  // 切到「API 随机图」且已填地址时自动拉一张做预览（不写设置）；地址为空 = 关闭，一次请求都不发。
  useEffect(() => {
    if (!apiEnabled) {
      setApiBg(null);
      setApiError(null);
      apiAutoRef.current = false;
      return;
    }
    if (apiAutoRef.current) return;
    apiAutoRef.current = true;
    void (async () => {
      setApiRolling(true);
      try {
        const next = await api.media.apiBackground();
        if (next) setApiBg(next);
      } catch (error: unknown) {
        setApiError(errorMessage(error));
      } finally {
        setApiRolling(false);
      }
    })();
  }, [apiEnabled]);

  // 设置回读（例如在别的页面改了音量）时把草稿拉回来，避免滑杆和真实值不一致。
  useEffect(() => {
    setVideoVolumeDraft(Math.round((settings?.backgroundVideoVolume ?? 0) * 100));
  }, [settings?.backgroundVideoVolume]);

  // 视频背景音量：0 = 静音（App 里会真的把 <video> muted），其余按 0–1 存。
  const commitVideoVolume = () => {
    const next = Math.min(100, Math.max(0, Math.round(videoVolumeDraft)));
    if (next === Math.round((settings?.backgroundVideoVolume ?? 0) * 100)) return;
    void persist({ backgroundVideoVolume: next / 100 }, next === 0 ? "视频音量（静音）" : "视频音量");
  };

  // 试听与「启动时播放」互不影响：只临时播一遍，播完（或再点一次）停止。
  const togglePreview = async () => {
    if (previewing) {
      stopPreviewSound();
      setPreviewing(false);
      return;
    }
    try {
      const { url } = await api.app.startupSound();
      if (!url) {
        push("没有可试听的启动音效（已关闭或文件不存在）", "info");
        return;
      }
      const started = await playPreviewSound(url, startupVolume, () => setPreviewing(false));
      if (!started) {
        push("试听失败：浏览器可能拦截了播放，请先点击页面空白处再试", "error");
        return;
      }
      setPreviewing(true);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  // 标题栏文字：失焦 / 回车落盘，空串回落到默认「奶娃启动器 NaiWa Launcher」。
  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next === (settings?.titleBarText ?? "")) return;
    void persist({ titleBarText: next }, next ? "标题栏文字" : "标题栏文字（已清空，用默认文字）");
  };

  // 轮播间隔：5–600 秒，改完立即按新间隔重排定时器（落到当前来源那套字段）。
  const commitInterval = () => {
    const next = clampInterval(Number(intervalDraft));
    setIntervalDraft(String(next));
    if (next === playbackInterval) return;
    setPlaybackInterval(next);
  };

  const togglePlay = async () => {
    if (!settings?.backgroundMusic) {
      push("请先选择一首背景音乐", "info");
      return;
    }
    if (music.playing) {
      pauseMusic();
      return;
    }
    // 失败静默：浏览器拦截自动播放时按钮保持「播放」。
    await playMusic();
  };

  if (!settings) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">个性化</h1>
        </header>
        <LoadingState label="读取个性化设置…" />
      </section>
    );
  }

  const backgrounds = media.data?.backgrounds ?? [];
  const tracks = media.data?.music ?? [];
  const icons = media.data?.icons ?? [];
  const bgUrl = settings.backgroundImage ? mediaUrl(media.data?.dirs.backgrounds ?? "", settings.backgroundImage) : "";

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">个性化</h1>
          <p className="page-sub">主题、背景与标题栏，改动即时预览并写入 config/settings.json</p>
        </div>
      </header>

      <div className="settings-grid">
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">基础</h2>
            <span className="panel-count">即时生效</span>
          </div>

          <Field label="界面不透明度" hint="只作用于卡片与面板底色，窗口本身保持不透明；60%–100%">
            <div className="slider">
              <input
                type="range"
                min={0.6}
                max={1}
                step={0.05}
                value={opacity}
                aria-label="界面不透明度"
                style={{ background: trackFill((opacity - 0.6) / 0.4) }}
                onChange={(event) => previewOpacity(Number(event.target.value))}
                onPointerUp={commitOpacity}
                onKeyUp={commitOpacity}
              />
              <span className="slider-value" data-opacity-value>{pct(opacity)}</span>
            </div>
          </Field>

          <Field label="主题色" hint="15 套预设，选中后全站按钮、高亮与徽标即时变色">
            <div className="theme-grid" role="radiogroup" aria-label="主题色">
              {THEME_PRESETS.map((preset) => {
                const active = settings.theme === preset.id;
                const swatch = preset.id === "custom"
                  ? (isHexColor(colorDraft) ? colorDraft.toUpperCase() : preset.color)
                  : preset.color;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={preset.name}
                    className={`theme-dot ${active ? "active" : ""}`.trim()}
                    data-theme-id={preset.id}
                    title={`${preset.name} ${swatch}`}
                    onClick={() => pickTheme(preset.id)}
                  >
                    <span className="theme-swatch" style={{ background: swatch }} />
                    <span className="theme-name">{preset.name}</span>
                  </button>
                );
              })}
            </div>
          </Field>

          {settings.theme === "custom" ? (
            <Field label="自定义颜色" hint="拖动取色器即时预览，松手后保存到 accentColor">
              <div className="color-row">
                <input
                  type="color"
                  className="color-input"
                  aria-label="自定义主题色"
                  value={isHexColor(colorDraft) ? colorDraft : "#E0A93B"}
                  onChange={(event) => previewAccent(event.target.value)}
                  onBlur={commitAccent}
                />
                <span className="mono color-value">{colorDraft.toUpperCase()}</span>
              </div>
            </Field>
          ) : null}

          <Toggle
            label="渐变配色"
            hint="开启后按钮、标题栏、选中态使用渐变；关闭则全部退化为纯色（对全部主题生效）"
            checked={settings.customGradient}
            onChange={(value) => void persist({ customGradient: value }, "渐变配色")}
          />

          {settings.customGradient ? (
            <Field label="渐变色" hint="留空＝跟随主题：起始色用主题主色，结束色由主色推导（色相 +40°）">
              <div className="grad-editor">
                <div className="grad-preview" aria-label="渐变预览" style={{ background: "var(--accent-grad)" }} />
                <div className="color-row">
                  <input
                    type="color"
                    className="color-input"
                    aria-label="渐变起始色"
                    value={isHexColor(gradFromDraft) ? gradFromDraft : accentOf(settings.theme, colorDraft)}
                    onChange={(event) => previewFrom(event.target.value)}
                    onBlur={commitFrom}
                  />
                  <span className="mono color-value" data-grad-value="from">{gradFromDraft ? gradFromDraft.toUpperCase() : "跟随主题（主色）"}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-grad-follow="from"
                    disabled={!gradFromDraft}
                    onClick={() => followTheme("from")}
                  >
                    跟随主题
                  </button>
                </div>
                <div className="color-row">
                  <input
                    type="color"
                    className="color-input"
                    aria-label="渐变结束色"
                    value={isHexColor(gradToDraft) ? gradToDraft : derivedGradEnd(settings.theme, colorDraft)}
                    onChange={(event) => previewTo(event.target.value)}
                    onBlur={commitTo}
                  />
                  <span className="mono color-value" data-grad-value="to">{gradToDraft ? gradToDraft.toUpperCase() : "跟随主题（自动推导）"}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-grad-follow="to"
                    disabled={!gradToDraft}
                    onClick={() => followTheme("to")}
                  >
                    跟随主题
                  </button>
                </div>
              </div>
            </Field>
          ) : null}

          <Toggle
            label="打开启动器时显示 logo 动画"
            hint="关闭后跳过开场 logo 渐显动画"
            checked={settings.showSplash}
            onChange={(value) => void persist({ showSplash: value }, "开场动画")}
          />
        </div>

        <div className={`panel bg-panel ${settings.backgroundEnabled ? "" : "is-bg-off"}`.trim()}>
          <div className="panel-head">
            <h2 className="panel-title">背景</h2>
            <span className="panel-count">
              {bgSource === "local" ? "NaiWa/backgrounds" : bgSource === "api" ? "API 随机图" : "Steam 壁纸引擎"}
            </span>
          </div>

          {/* 总开关：关掉后整个背景层都不渲染，API 随机图也不发请求（配置仍可改） */}
          <div data-bg-enabled={settings.backgroundEnabled ? "on" : "off"}>
            <Toggle
              label="启用背景"
              hint="总开关：关掉后背景层完全不显示（API 随机图也不会发请求），下面的配置会保留，随时可以再打开"
              checked={settings.backgroundEnabled}
              onChange={(value) => void persist({ backgroundEnabled: value }, value ? "启用背景" : "关闭背景")}
            />
          </div>

          {!settings.backgroundEnabled ? (
            <p className="field-hint bg-off-notice" data-bg-off-notice>
              背景总开关已关闭：下面仍可调整来源与参数，但不会显示任何背景，API 随机图也不会发请求。
            </p>
          ) : null}

          {/* 背景来源三选：只有「本地」与「壁纸引擎」会用 backgroundImage，API 模式走独立请求 */}
          <div className="segmented" role="tablist" aria-label="背景来源">
            {BG_SOURCES.map((item) => {
              const on = sourceEnabled(item.value);
              return (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={bgSource === item.value}
                  className={`segmented-item ${bgSource === item.value ? "active" : ""} ${on ? "" : "is-off"}`.trim()}
                  data-bg-source={item.value}
                  data-bg-source-state={on ? "on" : "off"}
                  onClick={() => void persist({ backgroundSource: item.value }, "背景来源")}
                >
                  {item.label}
                  {on ? null : <span className="bg-source-off">已关闭</span>}
                </button>
              );
            })}
          </div>

          {bgSource === "local" && media.loading ? <LoadingState label="读取背景图片…" /> : null}
          {media.error ? <ErrorState message={media.error} onRetry={media.reload} /> : null}

          {bgSource === "local" && !media.loading && !media.error && backgrounds.length === 0 ? (
            <p className="media-empty">
              还没有背景资源：把图片（png / jpg / jpeg / webp / gif / bmp）或视频（mp4 / webm / ogv）放进 NaiWa/backgrounds，再点下面的「刷新背景图片」。
            </p>
          ) : null}

          <Toggle
            label="叠加彩色背景"
            hint="开启时在背景图上再叠一层主题色蒙版，关闭则只保留深色蒙版"
            checked={tint}
            onChange={toggleTint}
          />

          {bgSource === "local" ? (
            <>
            <div data-bg-source-enabled="local" data-bg-source-state={settings.backgroundLocalEnabled ? "on" : "off"}>
              <Toggle
                label="启用本地背景"
                hint="关掉后即使当前来源是「本地背景图」也不显示背景"
                checked={settings.backgroundLocalEnabled}
                onChange={(value) => void persist({ backgroundLocalEnabled: value }, value ? "启用本地背景" : "关闭本地背景")}
              />
            </div>
            <Field
              label="背景图 / 视频"
              hint="支持图片与视频（mp4 / webm / ogv）：把文件放进 NaiWa/backgrounds 后点刷新；选中后立即铺满窗口"
            >
              <Select
                value={settings.backgroundImage}
                // 第一项是「不使用背景」：空串是有效选项，所以 keepEmpty（否则 Select 会把它当成 placeholder）
                options={[
                  { value: "", label: "不使用背景（只留主题色）" },
                  ...backgrounds.map((name, index) => ({ value: name, label: mediaLabel(name, index) })),
                ]}
                keepEmpty
                ariaLabel="背景图片"
                disabled={media.loading}
                onChange={pickBackground}
              />
            </Field>
            </>
          ) : null}

          {bgSource === "api" ? (
            <>
              <div data-bg-source-enabled="api" data-bg-source-state={settings.backgroundApiEnabled ? "on" : "off"}>
                <Toggle
                  label="启用 API 随机图"
                  hint="关掉后即使当前来源是「API 随机图」也不会请求、不会显示"
                  checked={settings.backgroundApiEnabled}
                  onChange={(value) => void persist({ backgroundApiEnabled: value }, value ? "启用 API 随机图" : "关闭 API 随机图")}
                />
              </div>
              <Field
                label="随机图地址"
                hint="地址可以直接返回图片，也可以返回包含图片地址的 JSON（主进程会挑出图片字段）。留空 = 关闭 API 随机图"
              >
                <div className="key-row">
                  <TextInput
                    value={apiUrlDraft}
                    // placeholder 只是灰字示例：不会写进设置，也不会被请求
                    placeholder={API_BG_PLACEHOLDER}
                    aria-label="API 随机图地址"
                    spellCheck={false}
                    autoComplete="off"
                    data-bg-api-url
                    onChange={(event) => setApiUrlDraft(event.target.value)}
                    onBlur={commitApiUrl}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitApiUrl();
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-action="refresh-api-background"
                    onClick={() => void rollApiBackground(true)}
                    disabled={apiRolling || !apiUrl}
                    title={apiUrl ? "立即向该地址要一张新图" : "先在左边填写地址"}
                  >
                    {apiRolling ? "拉取中…" : "立即换一张"}
                  </button>
                </div>
              </Field>

              {!apiUrl ? (
                <p className="field-hint" data-bg-api-off>
                  未填写地址（相当于关闭）：填一个能返回图片的地址才会开始请求。地址清空即关闭 API 随机图，背景回到「不使用」。
                </p>
              ) : (
                <p className="field-hint" data-bg-api-on>
                  地址可以直接返回图片，也可以返回包含图片地址的 JSON；「立即换一张」会重新请求一次。
                </p>
              )}

              {apiError ? <p className="server-form-error" data-bg-api-error>{apiError}</p> : null}

              {apiBg ? (
                <div className="media-preview" data-media-preview={apiBg.kind}>
                  {apiBg.kind === "video" ? (
                    <video className="media-preview-video" src={mediaUrl("", apiBg.url)} muted loop autoPlay playsInline />
                  ) : (
                    <img src={mediaUrl("", apiBg.url)} alt="API 随机图预览" />
                  )}
                  <span className="media-preview-name">API 随机图（{apiBg.source}）</span>
                </div>
              ) : null}
            </>
          ) : null}

          {/* 播放方式与间隔：按当前来源落到各自的字段（local / api / wallpaperEngine 三套） */}
          <div className="bg-playback" data-bg-playback={bgSource}>
            <Field label="播放方式" hint="单张＝只用所选图片；顺序轮播＝按文件名排序循环；随机轮播＝每次随机取，不连续重复">
              <Select
                value={playbackMode}
                options={BACKGROUND_MODES.map((item) => ({ value: item.value, label: item.label }))}
                ariaLabel="背景播放方式"
                disabled={bgSource === "local" && backgrounds.length === 0}
                onChange={(value) => setPlaybackMode(value as BackgroundMode)}
              />
            </Field>

            <Field label="轮播间隔" hint="5–600 秒；轮播中修改会立即按新间隔重排">
              <div className="interval-row">
                <input
                  type="number"
                  className="input interval-input"
                  min={BACKGROUND_INTERVAL_MIN}
                  max={BACKGROUND_INTERVAL_MAX}
                  step={1}
                  value={intervalDraft}
                  aria-label="轮播间隔（秒）"
                  disabled={playbackMode === "single"}
                  onChange={(event) => setIntervalDraft(event.target.value)}
                  onBlur={commitInterval}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitInterval();
                  }}
                />
                <span className="interval-unit">秒</span>
              </div>
            </Field>
          </div>

          {bgSource !== "api" && bgUrl ? (
            <div className="media-preview" data-media-preview={isVideoFile(settings.backgroundImage) ? "video" : "image"}>
              {isVideoFile(settings.backgroundImage) ? (
                // 预览也走视频元素：当图片渲染会是一块空白
                <video src={bgUrl} muted loop autoPlay playsInline className="media-preview-video" />
              ) : (
                <img src={bgUrl} alt="背景图片预览" />
              )}
              <span className="media-preview-name">{mediaLabel(settings.backgroundImage)}</span>
            </div>
          ) : null}

          {/* 只有视频背景才有音量可调；图片背景不显示这一行 */}
          {isVideoFile(settings.backgroundImage) ? (
            <Field
              label="视频音量"
              hint="0% 为静音；有声音时会和背景音乐一起播放，按需调小"
            >
              <div
                data-bg-video-volume={videoVolumeDraft}
                onPointerUp={commitVideoVolume}
                onKeyUp={commitVideoVolume}
                onBlur={commitVideoVolume}
              >
                <Slider
                  value={videoVolumeDraft}
                  min={0}
                  max={100}
                  step={1}
                  onChange={setVideoVolumeDraft}
                  format={(value) => (value === 0 ? "静音" : `${value}%`)}
                />
              </div>
            </Field>
          ) : null}

          {isVideoFile(settings.backgroundImage) ? (
            <p className="field-hint" data-bg-video-hint>
              {videoVolumeDraft === 0 ? "视频背景自动循环播放，当前静音。" : `视频背景自动循环播放，音量 ${videoVolumeDraft}%。`}
            </p>
          ) : null}

          {bgSource === "local" ? (
            <div className="media-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openDir("backgrounds", "背景图片")}>
                <IconFolder size={14} />
                打开文件夹
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={refreshMedia}>
                <IconRefresh size={14} />
                刷新背景图片
              </button>
            </div>
          ) : null}
        </div>

        {bgSource === "wallpaperEngine" ? (
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Steam 壁纸引擎</h2>
            <button type="button" className="btn btn-ghost btn-sm" data-action="refresh-wallpapers" onClick={() => wallpapers.reload()}>
              <IconRefresh size={14} />
              刷新
            </button>
          </div>

          <p className="field-hint">
            识别路径：<code className="mono">&lt;Steam 库&gt;\steamapps\workshop\content\431960</code>；只识别视频类壁纸（creative workshop 应用 id 431960），扫不到时可以在设置里手动指定目录。
          </p>

          <div data-bg-source-enabled="wallpaperEngine" data-bg-source-state={settings.backgroundWallpaperEnabled ? "on" : "off"}>
            <Toggle
              label="启用壁纸引擎背景"
              hint="关掉后即使当前来源是「Steam 壁纸引擎」也不显示背景"
              checked={settings.backgroundWallpaperEnabled}
              onChange={(value) => void persist({ backgroundWallpaperEnabled: value }, value ? "启用壁纸引擎背景" : "关闭壁纸引擎背景")}
            />
          </div>

          {wallpapers.loading ? <LoadingState label="扫描壁纸引擎目录…" /> : null}
          {wallpapers.error ? <ErrorState message={wallpapers.error} onRetry={wallpapers.reload} /> : null}

          {!wallpapers.loading && !wallpapers.error && (wallpapers.data ?? []).length === 0 ? (
            <p className="media-empty" data-wallpaper-empty>
              没有找到壁纸：确认 Wallpaper Engine 已安装并订阅过壁纸（应用 id 431960），或到设置里把「Wallpaper Engine 目录」指到
              {" "}<code className="mono">&lt;Steam 库&gt;\steamapps\workshop\content\431960</code> 后点刷新。
            </p>
          ) : null}

          {(wallpapers.data ?? []).length > 0 ? (
            <div className="wp-grid" data-wallpaper-grid>
              {(wallpapers.data ?? []).map((entry) => {
                // 选中态按 videoPath / imagePath 任一匹配；视频壁纸也可能同时有静态预览图
                const target = entry.videoPath || entry.imagePath;
                const using = Boolean(target) && settings.backgroundImage === target;
                const preview = entry.previewPath ? mediaUrl("", entry.previewPath) : "";
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`wp-card ${using ? "is-active" : ""}`.trim()}
                    data-wallpaper-card={entry.id}
                    data-wallpaper-kind={entry.kind}
                    onClick={() => {
                      if (!target) {
                        push("这条壁纸既没有视频也没有静态图，不能当背景", "info");
                        return;
                      }
                      // 视频壁纸 → 视频背景；只有静态图 → 图片背景；顺带把来源钉在「壁纸引擎」
                      void persist(
                        { backgroundSource: "wallpaperEngine", backgroundImage: target },
                        entry.videoPath ? "壁纸引擎视频背景" : "壁纸引擎静态背景",
                      );
                    }}
                    title={target || entry.dir}
                  >
                    {preview ? (
                      <img
                        className="wp-preview"
                        src={preview}
                        alt=""
                        loading="lazy"
                        onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                      />
                    ) : (
                      <span className="wp-preview wp-preview-empty" aria-hidden="true" />
                    )}
                    <span className="wp-title" title={entry.title}>{entry.title}</span>
                    <span className="badge wp-kind">{entry.kind}</span>
                    {using ? <span className="wp-in-use" data-wallpaper-in-use>当前使用</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        ) : null}

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">背景音乐</h2>
            <span className="panel-count">NaiWa/music · 循环播放</span>
          </div>

          {media.loading ? <LoadingState label="读取背景音乐…" /> : null}
          {media.error ? <ErrorState message={media.error} onRetry={media.reload} /> : null}

          <Field label="曲目" hint="支持 mp3 / ogg / wav / flac / m4a">
            <Select
              value={settings.backgroundMusic}
              options={tracks.map((name) => ({ value: name, label: mediaLabel(name) }))}
              placeholder="不使用背景音乐"
              ariaLabel="背景音乐"
              disabled={media.loading}
              onChange={pickMusic}
            />
          </Field>

          <div className="music-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void togglePlay()}>
              {music.playing ? <IconPause size={14} /> : <IconPlay size={14} />}
              {music.playing ? "暂停" : "播放"}
            </button>
            <div className="slider">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                aria-label="背景音乐音量"
                style={{ background: trackFill(volume) }}
                onChange={(event) => previewVolume(Number(event.target.value))}
                onPointerUp={commitVolume}
                onKeyUp={commitVolume}
              />
              <span className="slider-value">{pct(volume)}</span>
            </div>
          </div>

          <div className="media-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openDir("music", "背景音乐")}>
              <IconFolder size={14} />
              打开文件夹
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={refreshMedia}>
              <IconRefresh size={14} />
              刷新背景音乐
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">启动音效</h2>
            <span className="panel-count">启动器打开时播放一次</span>
          </div>

          <Field label="音效" hint="默认关闭；选「默认（内置 bgm.mp3）」播放启动器自带音效，把音频放进 NaiWa/music 后可在这里选择">
            <Select
              value={settings.startupSound}
              keepEmpty
              options={[
                { value: "off", label: "关闭" },
                { value: "", label: "默认（内置 bgm.mp3）" },
                ...tracks.map((name) => ({ value: name, label: mediaLabel(name) })),
              ]}
              ariaLabel="启动音效"
              placeholder="默认（内置 bgm.mp3）"
              disabled={media.loading}
              onChange={pickStartupSound}
            />
          </Field>

          <div className="music-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void togglePreview()}>
              {previewing ? <IconPause size={14} /> : <IconPlay size={14} />}
              {previewing ? "停止" : "试听"}
            </button>
            <div className="slider">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={startupVolume}
                aria-label="启动音效音量"
                style={{ background: trackFill(startupVolume) }}
                onChange={(event) => setStartupVolume(Number(event.target.value))}
                onPointerUp={commitStartupVolume}
                onKeyUp={commitStartupVolume}
              />
              <span className="slider-value">{pct(startupVolume)}</span>
            </div>
          </div>

          <p className="field-hint">试听只临时播放一遍，不影响「启动时播放」与上面选中的背景音乐。</p>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">标题栏</h2>
            <span className="panel-count">即时生效</span>
          </div>

          <div className="titlebar-options" role="radiogroup" aria-label="标题栏样式">
            {TITLE_BARS.map((option) => {
              const active = settings.titleBar === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`source-card ${active ? "active" : ""}`.trim()}
                  data-titlebar={option.value}
                  onClick={() => void persist({ titleBar: option.value }, "标题栏样式")}
                >
                  <span className={`radio-dot ${active ? "on" : ""}`} aria-hidden="true" />
                  <span className="source-text">
                    <span className="source-name">{option.label}</span>
                    <span className="source-desc">{option.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <Field label="标题栏文字" hint="留空则显示默认「奶娃启动器 NaiWa Launcher」">
            <TextInput
              value={titleDraft}
              placeholder="奶娃启动器 NaiWa Launcher"
              aria-label="标题栏文字"
              maxLength={48}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitTitle();
              }}
            />
          </Field>

          <p className="field-hint">切换后立即生效（窗口已无边框）。</p>
        </div>

        <div className="panel" data-icon-panel>
          <div className="panel-head">
            <h2 className="panel-title">界面图标</h2>
            <span className="panel-count">即时预览</span>
          </div>

          {media.error ? <ErrorState message={media.error} onRetry={media.reload} /> : null}

          <div className="media-preview icon-preview">
            <img src={iconSrc(iconUrl)} alt="当前界面图标" data-icon-preview />
            <span className="media-preview-name" data-icon-name>{settings.appIcon || "内置 logo.png"}</span>
          </div>

          {settings.appIcon && !iconUrl ? (
            <p className="field-hint" data-icon-missing>
              选中的图标暂时读不到（可能已被删除），标题栏与侧边栏先用内置 logo。
            </p>
          ) : null}

          <Field label="图标文件" hint="默认使用打包进启动器的 logo；选中 NaiWa/icons 里的文件后标题栏、侧边栏、启动画面与实例列表头像即时换图">
            <div className="icon-grid" role="radiogroup" aria-label="界面图标">
              <button
                type="button"
                role="radio"
                aria-checked={settings.appIcon === ""}
                className={`icon-choice ${settings.appIcon === "" ? "active" : ""}`.trim()}
                data-icon-choice=""
                title="使用内置 logo"
                onClick={() => void pickIcon("")}
              >
                <img src={logo} alt="" />
                <span className="icon-filename">默认（内置）</span>
              </button>
              {icons.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={settings.appIcon === name}
                  className={`icon-choice ${settings.appIcon === name ? "active" : ""}`.trim()}
                  data-icon-choice={name}
                  title={name}
                  onClick={() => void pickIcon(name)}
                >
                  <img
                    src={mediaUrl(media.data?.dirs.icons ?? "", name)}
                    alt=""
                    // 读不到真图（浏览器预览没有 NaiWa 目录）就留空占位，别和「默认（内置）」混淆。
                    onError={(event) => {
                      event.currentTarget.style.visibility = "hidden";
                    }}
                  />
                  <span className="icon-filename">{name}</span>
                </button>
              ))}
            </div>
          </Field>

          <p className="field-hint" data-icon-note>
            把 png/ico（建议 256×256 及以上）放进 NaiWa/icons 即可在这里选择；Windows 任务栏图标会在下次启动时应用。
          </p>

          <div className="media-actions">
            <button type="button" className="btn btn-ghost btn-sm" data-action="open-icons" onClick={() => void openIconFolder()}>
              <IconFolder size={14} />
              打开图标目录
            </button>
            <button type="button" className="btn btn-ghost btn-sm" data-action="refresh-icons" onClick={refreshIcons}>
              <IconRefresh size={14} />
              刷新
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
