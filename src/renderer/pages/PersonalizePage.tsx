import { useEffect, useRef, useState } from "react";
import type { ApiBackground, BackgroundMode, Settings, ThemeId, TitleBarStyle, WallpaperEntry } from "../../shared/types";
import { api } from "../lib/api";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
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
const TITLE_BARS: Array<{ value: TitleBarStyle; labelKey: string; hintKey: string }> = [
  { value: "compact", labelKey: "pages.personalize.barCompact", hintKey: "pages.personalize.barCompactHint" },
  { value: "image", labelKey: "pages.personalize.barImage", hintKey: "pages.personalize.barImageHint" },
];

/** 背景来源三选：本地目录 / API 随机图 / Steam 壁纸引擎。 */
const BG_SOURCES: Array<{ value: Settings["backgroundSource"]; labelKey: string }> = [
  { value: "local", labelKey: "pages.personalize.srcLocal" },
  { value: "api", labelKey: "pages.personalize.srcApi" },
  { value: "wallpaperEngine", labelKey: "pages.personalize.srcWe" },
];

/** API 随机图的示例地址：只当 placeholder 灰字提示，永远不写进设置、也不会被请求。 */
const API_BG_PLACEHOLDER = "https://example.com/api/random?size=1920x1080";

const BACKGROUND_MODES: Array<{ value: BackgroundMode; labelKey: string }> = [
  { value: "single", labelKey: "pages.personalize.modeSingle" },
  { value: "sequence", labelKey: "pages.personalize.modeSequence" },
  { value: "random", labelKey: "pages.personalize.modeRandom" },
];

/** 主题预设的显示名：id 与配色来自 lib/theme，这里只把名字映射到三语 key。 */
const THEME_NAME_KEY: Record<string, string> = {
  dragon: "pages.personalize.themeDragon",
  lemon: "pages.personalize.themeLemon",
  grass: "pages.personalize.themeGrass",
  pineapple: "pages.personalize.themePineapple",
  oak: "pages.personalize.themeOak",
  midnight: "pages.personalize.themeMidnight",
  candy: "pages.personalize.themeCandy",
  pink: "pages.personalize.themePink",
  mystery: "pages.personalize.themeMystery",
  lucky: "pages.personalize.themeLucky",
  autumn: "pages.personalize.themeAutumn",
  orange: "pages.personalize.themeOrange",
  red: "pages.personalize.themeRed",
  geek: "pages.personalize.themeGeek",
  custom: "pages.personalize.themeCustom",
};

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/** 滑杆填充色跟随主题（Form.Slider 内部写死了 --amber，这里用 --accent）。 */
const trackFill = (ratio: number): string =>
  `linear-gradient(90deg, var(--accent) ${ratio * 100}%, color-mix(in srgb, var(--text) 14%, transparent) ${ratio * 100}%)`;

export function PersonalizePage() {
  const { settings, iconUrl, reloadIcon } = useApp();
  const { push } = useToast();
  const t = useT();
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
      push(t("pages.personalize.openedFolder", { label }), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const refreshMedia = () => {
    media.reload();
    push(t("pages.personalize.mediaRefreshed"), "info");
  };

  const openIconFolder = async () => {
    try {
      await openIconsDir();
      push(t("pages.personalize.iconsOpened"), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const refreshIcons = () => {
    media.reload();
    push(t("pages.personalize.iconsRefreshed"), "info");
  };

  // 图标换完要显式让主进程重算 file:// 直链，标题栏/侧边栏才会即时换图。
  const pickIcon = async (value: string) => {
    const saved = await persist(
      { appIcon: value },
      value ? t("pages.personalize.persistAppIcon", { name: value }) : t("pages.personalize.persistAppIconDefault"),
    );
    if (saved) await reloadIcon();
  };

  // 拖动时先改 CSS 变量做实时预览，松手/松键才落盘。
  const previewOpacity = (value: number) => {
    setOpacity(value);
    applyUiOpacity(value);
  };
  const commitOpacity = () => void persist({ uiOpacity: opacity }, t("pages.personalize.persistOpacity"));

  const previewVolume = (value: number) => {
    setVolume(value);
    setMusicVolume(value);
  };
  const commitVolume = () => void persist({ musicVolume: volume }, t("pages.personalize.persistMusicVolume"));

  const pickTheme = (id: ThemeId) => {
    if (id === "custom") {
      void persist({ theme: "custom", accentColor: colorDraft }, t("pages.personalize.persistCustomAccent"));
      return;
    }
    void persist({ theme: id }, t("pages.personalize.persistTheme"));
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
  const commitAccent = () => void persist({ theme: "custom", accentColor: colorDraft }, t("pages.personalize.persistCustomAccent"));

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
    void persist({ gradientFrom: gradFromDraft }, t("pages.personalize.persistGradFrom"));
  };
  const commitTo = () => {
    if ((settings?.gradientTo ?? "").toUpperCase() === gradToDraft.toUpperCase()) return;
    void persist({ gradientTo: gradToDraft }, t("pages.personalize.persistGradTo"));
  };
  /** 清空为 ""：回到「跟随主题」的推导配色。 */
  const followTheme = (side: "from" | "to") => {
    if (side === "from") {
      setGradFromDraft("");
      previewGradient("", gradToDraft);
      void persist({ gradientFrom: "" }, t("pages.personalize.persistGradFromFollow"));
      return;
    }
    setGradToDraft("");
    previewGradient(gradFromDraft, "");
    void persist({ gradientTo: "" }, t("pages.personalize.persistGradToFollow"));
  };

  const toggleTint = (value: boolean) => {
    setTint(value);
    writeBgTint(value);
  };

  const pickBackground = (value: string) =>
    void persist(
      { backgroundImage: value },
      value ? t("pages.personalize.persistBackground") : t("pages.personalize.persistBackgroundOff"),
    );

  const pickMusic = (value: string) =>
    void persist(
      { backgroundMusic: value },
      value ? t("pages.personalize.persistMusic") : t("pages.personalize.persistMusicOff"),
    );

  const pickStartupSound = (value: string) =>
    void persist(
      { startupSound: value },
      value === "off"
        ? t("pages.personalize.persistStartupSoundOff")
        : value ? t("pages.personalize.persistStartupSound") : t("pages.personalize.persistStartupSoundBuiltin"),
    );

  const commitStartupVolume = () => void persist({ startupVolume }, t("pages.personalize.persistStartupVolume"));

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
      void persist({ apiBackgroundMode: value }, t("pages.personalize.persistApiMode"));
      return;
    }
    if (bgSource === "wallpaperEngine") {
      void persist({ wallpaperBackgroundMode: value }, t("pages.personalize.persistWeMode"));
      return;
    }
    void persist({ backgroundMode: value }, t("pages.personalize.persistLocalMode"));
  };

  const setPlaybackInterval = (value: number) => {
    if (bgSource === "api") {
      void persist({ apiBackgroundIntervalSec: value }, t("pages.personalize.persistApiInterval"));
      return;
    }
    if (bgSource === "wallpaperEngine") {
      void persist({ wallpaperBackgroundIntervalSec: value }, t("pages.personalize.persistWeInterval"));
      return;
    }
    void persist({ backgroundIntervalSec: value }, t("pages.personalize.persistLocalInterval"));
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
    void persist(
      { backgroundApiUrl: next },
      next ? t("pages.personalize.persistApiUrl") : t("pages.personalize.persistApiUrlCleared"),
    );
  };

  /** 拉一张随机图：writeSettings=false 只更新本页预览（进入模式时用），按钮传 true 顺便记成当前背景。 */
  const rollApiBackground = async (writeSettings = true) => {
    if (!apiUrl) {
      setApiError(t("pages.personalize.apiOffHint"));
      return;
    }
    setApiRolling(true);
    setApiError(null);
    try {
      const next = await api.media.apiBackground();
      if (!next) {
        setApiError(t("pages.personalize.apiEmptyResponse"));
        return;
      }
      setApiBg(next);
      if (writeSettings) await persist({ backgroundImage: next.url }, t("pages.personalize.persistApiBackground"));
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
    void persist(
      { backgroundVideoVolume: next / 100 },
      next === 0 ? t("pages.personalize.persistVideoVolumeMuted") : t("pages.personalize.persistVideoVolume"),
    );
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
        push(t("pages.personalize.noStartupSound"), "info");
        return;
      }
      const started = await playPreviewSound(url, startupVolume, () => setPreviewing(false));
      if (!started) {
        push(t("pages.personalize.previewBlocked"), "error");
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
    void persist(
      { titleBarText: next },
      next ? t("pages.personalize.persistTitle") : t("pages.personalize.persistTitleCleared"),
    );
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
      push(t("pages.personalize.needMusicFirst"), "info");
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
          <h1 className="page-title">{t("pages.personalize.title")}</h1>
        </header>
        <LoadingState label={t("pages.personalize.loadingSettings")} />
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
          <h1 className="page-title">{t("pages.personalize.title")}</h1>
          <p className="page-sub">{t("pages.personalize.sub")}</p>
        </div>
      </header>

      <div className="settings-grid">
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{t("pages.personalize.sectionBasic")}</h2>
            <span className="panel-count">{t("pages.personalize.instantApply")}</span>
          </div>

          <Field label={t("pages.personalize.opacityLabel")} hint={t("pages.personalize.opacityHint")}>
            <div className="slider">
              <input
                type="range"
                min={0.6}
                max={1}
                step={0.05}
                value={opacity}
                aria-label={t("pages.personalize.opacityLabel")}
                style={{ background: trackFill((opacity - 0.6) / 0.4) }}
                onChange={(event) => previewOpacity(Number(event.target.value))}
                onPointerUp={commitOpacity}
                onKeyUp={commitOpacity}
              />
              <span className="slider-value" data-opacity-value>{pct(opacity)}</span>
            </div>
          </Field>

          <Field label={t("pages.personalize.themeLabel")} hint={t("pages.personalize.themeHint")}>
            <div className="theme-grid" role="radiogroup" aria-label={t("pages.personalize.themeLabel")}>
              {THEME_PRESETS.map((preset) => {
                const active = settings.theme === preset.id;
                const presetNameKey = THEME_NAME_KEY[preset.id];
                const presetName = presetNameKey ? t(presetNameKey) : preset.name;
                const swatch = preset.id === "custom"
                  ? (isHexColor(colorDraft) ? colorDraft.toUpperCase() : preset.color)
                  : preset.color;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={presetName}
                    className={`theme-dot ${active ? "active" : ""}`.trim()}
                    data-theme-id={preset.id}
                    title={`${presetName} ${swatch}`}
                    onClick={() => pickTheme(preset.id)}
                  >
                    <span className="theme-swatch" style={{ background: swatch }} />
                    <span className="theme-name">{presetName}</span>
                  </button>
                );
              })}
            </div>
          </Field>

          {settings.theme === "custom" ? (
            <Field label={t("pages.personalize.customColorLabel")} hint={t("pages.personalize.customColorHint")}>
              <div className="color-row">
                <input
                  type="color"
                  className="color-input"
                  aria-label={t("pages.personalize.customColorAria")}
                  value={isHexColor(colorDraft) ? colorDraft : "#E0A93B"}
                  onChange={(event) => previewAccent(event.target.value)}
                  onBlur={commitAccent}
                />
                <span className="mono color-value">{colorDraft.toUpperCase()}</span>
              </div>
            </Field>
          ) : null}

          <Toggle
            label={t("pages.personalize.gradientToggle")}
            hint={t("pages.personalize.gradientToggleHint")}
            checked={settings.customGradient}
            onChange={(value) => void persist({ customGradient: value }, t("pages.personalize.persistGradient"))}
          />

          {settings.customGradient ? (
            <Field label={t("pages.personalize.gradientLabel")} hint={t("pages.personalize.gradientHint")}>
              <div className="grad-editor">
                <div
                  className="grad-preview"
                  aria-label={t("pages.personalize.gradientPreviewAria")}
                  style={{ background: "var(--accent-grad)" }}
                />
                <div className="color-row">
                  <input
                    type="color"
                    className="color-input"
                    aria-label={t("pages.personalize.gradientFromAria")}
                    value={isHexColor(gradFromDraft) ? gradFromDraft : accentOf(settings.theme, colorDraft)}
                    onChange={(event) => previewFrom(event.target.value)}
                    onBlur={commitFrom}
                  />
                  <span className="mono color-value" data-grad-value="from">
                    {gradFromDraft ? gradFromDraft.toUpperCase() : t("pages.personalize.followThemeFrom")}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-grad-follow="from"
                    disabled={!gradFromDraft}
                    onClick={() => followTheme("from")}
                  >
                    {t("pages.personalize.followTheme")}
                  </button>
                </div>
                <div className="color-row">
                  <input
                    type="color"
                    className="color-input"
                    aria-label={t("pages.personalize.gradientToAria")}
                    value={isHexColor(gradToDraft) ? gradToDraft : derivedGradEnd(settings.theme, colorDraft)}
                    onChange={(event) => previewTo(event.target.value)}
                    onBlur={commitTo}
                  />
                  <span className="mono color-value" data-grad-value="to">
                    {gradToDraft ? gradToDraft.toUpperCase() : t("pages.personalize.followThemeTo")}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-grad-follow="to"
                    disabled={!gradToDraft}
                    onClick={() => followTheme("to")}
                  >
                    {t("pages.personalize.followTheme")}
                  </button>
                </div>
              </div>
            </Field>
          ) : null}

          <Toggle
            label={t("pages.personalize.splashToggle")}
            hint={t("pages.personalize.splashHint")}
            checked={settings.showSplash}
            onChange={(value) => void persist({ showSplash: value }, t("pages.personalize.persistSplash"))}
          />
        </div>

        <div className={`panel bg-panel ${settings.backgroundEnabled ? "" : "is-bg-off"}`.trim()}>
          <div className="panel-head">
            <h2 className="panel-title">{t("pages.personalize.sectionBackground")}</h2>
            <span className="panel-count">
              {bgSource === "local"
                ? "NaiWa/backgrounds"
                : t(bgSource === "api" ? "pages.personalize.srcApi" : "pages.personalize.srcWe")}
            </span>
          </div>

          {/* 总开关：关掉后整个背景层都不渲染，API 随机图也不发请求（配置仍可改） */}
          <div data-bg-enabled={settings.backgroundEnabled ? "on" : "off"}>
            <Toggle
              label={t("pages.personalize.enableBackground")}
              hint={t("pages.personalize.enableBackgroundHint")}
              checked={settings.backgroundEnabled}
              onChange={(value) => void persist(
                { backgroundEnabled: value },
                value ? t("pages.personalize.persistEnableBg") : t("pages.personalize.persistDisableBg"),
              )}
            />
          </div>

          {!settings.backgroundEnabled ? (
            <p className="field-hint bg-off-notice" data-bg-off-notice>
              {t("pages.personalize.bgOffNotice")}
            </p>
          ) : null}

          {/* 背景来源三选：只有「本地」与「壁纸引擎」会用 backgroundImage，API 模式走独立请求 */}
          <div className="segmented" role="tablist" aria-label={t("pages.personalize.bgSourceAria")}>
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
                  onClick={() => void persist({ backgroundSource: item.value }, t("pages.personalize.persistBgSource"))}
                >
                  {t(item.labelKey)}
                  {on ? null : <span className="bg-source-off">{t("pages.personalize.sourceOff")}</span>}
                </button>
              );
            })}
          </div>

          {bgSource === "local" && media.loading ? (
            <LoadingState label={t("pages.personalize.readingBackgrounds")} />
          ) : null}
          {media.error ? <ErrorState message={media.error} onRetry={media.reload} /> : null}

          {bgSource === "local" && !media.loading && !media.error && backgrounds.length === 0 ? (
            <p className="media-empty">{t("pages.personalize.backgroundsEmpty")}</p>
          ) : null}

          <Toggle
            label={t("pages.personalize.enableTint")}
            hint={t("pages.personalize.enableTintHint")}
            checked={tint}
            onChange={toggleTint}
          />

          {bgSource === "local" ? (
            <>
            <div data-bg-source-enabled="local" data-bg-source-state={settings.backgroundLocalEnabled ? "on" : "off"}>
              <Toggle
                label={t("pages.personalize.enableLocal")}
                hint={t("pages.personalize.enableLocalHint")}
                checked={settings.backgroundLocalEnabled}
                onChange={(value) => void persist(
                  { backgroundLocalEnabled: value },
                  value ? t("pages.personalize.persistEnableLocal") : t("pages.personalize.persistDisableLocal"),
                )}
              />
            </div>
            <div data-bg-startup-random="local" data-bg-startup-random-state={settings.backgroundStartupRandom ? "on" : "off"}>
              <Toggle
                label={t("pages.personalize.startupRandom")}
                hint={t("pages.personalize.startupRandomLocalHint")}
                checked={settings.backgroundStartupRandom}
                onChange={(value) => void persist(
                  { backgroundStartupRandom: value },
                  value ? t("pages.personalize.persistLocalRandomOn") : t("pages.personalize.persistLocalRandomOff"),
                )}
              />
            </div>
            <Field label={t("pages.personalize.bgPickLabel")} hint={t("pages.personalize.bgPickHint")}>
              <Select
                value={settings.backgroundImage}
                // 第一项是「不使用背景」：空串是有效选项，所以 keepEmpty（否则 Select 会把它当成 placeholder）
                options={[
                  { value: "", label: t("pages.personalize.noBackground") },
                  ...backgrounds.map((name, index) => ({ value: name, label: mediaLabel(name, index) })),
                ]}
                keepEmpty
                ariaLabel={t("pages.personalize.bgPickAria")}
                disabled={media.loading}
                onChange={pickBackground}
              />
            </Field>
            </>
          ) : null}

          {bgSource === "api" ? (
            <>
              <div data-bg-startup-random="api" data-bg-startup-random-state={settings.apiBackgroundStartupRandom ? "on" : "off"}>
                <Toggle
                  label={t("pages.personalize.startupRandom")}
                  hint={t("pages.personalize.startupRandomApiHint")}
                  checked={settings.apiBackgroundStartupRandom}
                  onChange={(value) => void persist(
                    { apiBackgroundStartupRandom: value },
                    value ? t("pages.personalize.persistApiRandomOn") : t("pages.personalize.persistApiRandomOff"),
                  )}
                />
              </div>
              <div data-bg-source-enabled="api" data-bg-source-state={settings.backgroundApiEnabled ? "on" : "off"}>
                <Toggle
                  label={t("pages.personalize.enableApi")}
                  hint={t("pages.personalize.enableApiHint")}
                  checked={settings.backgroundApiEnabled}
                  onChange={(value) => void persist(
                    { backgroundApiEnabled: value },
                    value ? t("pages.personalize.persistEnableApi") : t("pages.personalize.persistDisableApi"),
                  )}
                />
              </div>
              <Field label={t("pages.personalize.apiUrlLabel")} hint={t("pages.personalize.apiUrlHint")}>
                <div className="key-row">
                  <TextInput
                    value={apiUrlDraft}
                    // placeholder 只是灰字示例：不会写进设置，也不会被请求
                    placeholder={API_BG_PLACEHOLDER}
                    aria-label={t("pages.personalize.apiUrlAria")}
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
                    title={apiUrl
                      ? t("pages.personalize.rollNowTitle")
                      : t("pages.personalize.rollNeedUrlTitle")}
                  >
                    {apiRolling ? t("pages.personalize.rolling") : t("pages.personalize.rollNow")}
                  </button>
                </div>
              </Field>

              {!apiUrl ? (
                <p className="field-hint" data-bg-api-off>
                  {t("pages.personalize.apiOffHint")}
                </p>
              ) : (
                <p className="field-hint" data-bg-api-on>
                  {t("pages.personalize.apiOnHint")}
                </p>
              )}

              {apiError ? <p className="server-form-error" data-bg-api-error>{apiError}</p> : null}

              {apiBg ? (
                <div className="media-preview" data-media-preview={apiBg.kind}>
                  {apiBg.kind === "video" ? (
                    <video className="media-preview-video" src={mediaUrl("", apiBg.url)} muted loop autoPlay playsInline />
                  ) : (
                    <img src={mediaUrl("", apiBg.url)} alt={t("pages.personalize.apiPreviewAlt")} />
                  )}
                  <span className="media-preview-name">
                    {t("pages.personalize.apiPreviewName", { source: apiBg.source })}
                  </span>
                </div>
              ) : null}
            </>
          ) : null}

          {/* 播放方式与间隔：按当前来源落到各自的字段（local / api / wallpaperEngine 三套） */}
          <div className="bg-playback" data-bg-playback={bgSource}>
            <Field label={t("pages.personalize.playbackLabel")} hint={t("pages.personalize.playbackHint")}>
              <Select
                value={playbackMode}
                options={BACKGROUND_MODES.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
                ariaLabel={t("pages.personalize.playbackAria")}
                disabled={bgSource === "local" && backgrounds.length === 0}
                onChange={(value) => setPlaybackMode(value as BackgroundMode)}
              />
            </Field>

            <Field label={t("pages.personalize.intervalLabel")} hint={t("pages.personalize.intervalHint")}>
              <div className="interval-row">
                <input
                  type="number"
                  className="input interval-input"
                  min={BACKGROUND_INTERVAL_MIN}
                  max={BACKGROUND_INTERVAL_MAX}
                  step={1}
                  value={intervalDraft}
                  aria-label={t("pages.personalize.intervalAria")}
                  disabled={playbackMode === "single"}
                  onChange={(event) => setIntervalDraft(event.target.value)}
                  onBlur={commitInterval}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitInterval();
                  }}
                />
                <span className="interval-unit">{t("pages.personalize.intervalUnit")}</span>
              </div>
            </Field>
          </div>

          {bgSource !== "api" && bgUrl ? (
            <div className="media-preview" data-media-preview={isVideoFile(settings.backgroundImage) ? "video" : "image"}>
              {isVideoFile(settings.backgroundImage) ? (
                // 预览也走视频元素：当图片渲染会是一块空白
                <video src={bgUrl} muted loop autoPlay playsInline className="media-preview-video" />
              ) : (
                <img src={bgUrl} alt={t("pages.personalize.bgPreviewAlt")} />
              )}
              <span className="media-preview-name">{mediaLabel(settings.backgroundImage)}</span>
            </div>
          ) : null}

          {/* 只有视频背景才有音量可调；图片背景不显示这一行 */}
          {isVideoFile(settings.backgroundImage) ? (
            <Field label={t("pages.personalize.videoVolumeLabel")} hint={t("pages.personalize.videoVolumeHint")}>
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
                  format={(value) => (value === 0 ? t("pages.personalize.mute") : `${value}%`)}
                />
              </div>
            </Field>
          ) : null}

          {isVideoFile(settings.backgroundImage) ? (
            <p className="field-hint" data-bg-video-hint>
              {videoVolumeDraft === 0
                ? t("pages.personalize.videoHintMuted")
                : t("pages.personalize.videoHintLevel", { level: String(videoVolumeDraft) })}
            </p>
          ) : null}

          {bgSource === "local" ? (
            <div className="media-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void openDir("backgrounds", t("pages.personalize.backgroundsName"))}
              >
                <IconFolder size={14} />
                {t("pages.personalize.openFolder")}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={refreshMedia}>
                <IconRefresh size={14} />
                {t("pages.personalize.refreshBackgrounds")}
              </button>
            </div>
          ) : null}
        </div>

        {bgSource === "wallpaperEngine" ? (
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{t("pages.personalize.srcWe")}</h2>
            <button type="button" className="btn btn-ghost btn-sm" data-action="refresh-wallpapers" onClick={() => wallpapers.reload()}>
              <IconRefresh size={14} />
              {t("pages.personalize.refresh")}
            </button>
          </div>

          <p className="field-hint">
            {t("pages.personalize.wePathBefore")}
            <code className="mono">{t("pages.personalize.wePath")}</code>
            {t("pages.personalize.wePathAfter")}
          </p>

          <div data-bg-source-enabled="wallpaperEngine" data-bg-source-state={settings.backgroundWallpaperEnabled ? "on" : "off"}>
            <Toggle
              label={t("pages.personalize.enableWe")}
              hint={t("pages.personalize.enableWeHint")}
              checked={settings.backgroundWallpaperEnabled}
              onChange={(value) => void persist(
                { backgroundWallpaperEnabled: value },
                value ? t("pages.personalize.persistEnableWe") : t("pages.personalize.persistDisableWe"),
              )}
            />
          </div>
          <div data-bg-startup-random="wallpaperEngine" data-bg-startup-random-state={settings.wallpaperBackgroundStartupRandom ? "on" : "off"}>
            <Toggle
              label={t("pages.personalize.startupRandom")}
              hint={t("pages.personalize.startupRandomWeHint")}
              checked={settings.wallpaperBackgroundStartupRandom}
              onChange={(value) => void persist(
                { wallpaperBackgroundStartupRandom: value },
                value ? t("pages.personalize.persistWeRandomOn") : t("pages.personalize.persistWeRandomOff"),
              )}
            />
          </div>

          {wallpapers.loading ? <LoadingState label={t("pages.personalize.scanningWallpapers")} /> : null}
          {wallpapers.error ? <ErrorState message={wallpapers.error} onRetry={wallpapers.reload} /> : null}

          {!wallpapers.loading && !wallpapers.error && (wallpapers.data ?? []).length === 0 ? (
            <p className="media-empty" data-wallpaper-empty>
              {t("pages.personalize.wallpapersEmptyBefore")}
              {" "}<code className="mono">{t("pages.personalize.wePath")}</code>
              {t("pages.personalize.wallpapersEmptyAfter")}
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
                        push(t("pages.personalize.weNoMedia"), "info");
                        return;
                      }
                      // 视频壁纸 → 视频背景；只有静态图 → 图片背景；顺带把来源钉在「壁纸引擎」
                      void persist(
                        { backgroundSource: "wallpaperEngine", backgroundImage: target },
                        entry.videoPath
                          ? t("pages.personalize.persistWeVideo")
                          : t("pages.personalize.persistWeStatic"),
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
                    {using ? <span className="wp-in-use" data-wallpaper-in-use>{t("pages.personalize.inUse")}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        ) : null}

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{t("pages.personalize.musicTitle")}</h2>
            <span className="panel-count">
              NaiWa/music · {t("pages.personalize.musicLoop")}
            </span>
          </div>

          {media.loading ? <LoadingState label={t("pages.personalize.readingMusic")} /> : null}
          {media.error ? <ErrorState message={media.error} onRetry={media.reload} /> : null}

          <Field label={t("pages.personalize.trackLabel")} hint={t("pages.personalize.trackHint")}>
            <Select
              value={settings.backgroundMusic}
              options={tracks.map((name) => ({ value: name, label: mediaLabel(name) }))}
              placeholder={t("pages.personalize.noMusic")}
              ariaLabel={t("pages.personalize.musicAria")}
              disabled={media.loading}
              onChange={pickMusic}
            />
          </Field>

          <div className="music-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void togglePlay()}>
              {music.playing ? <IconPause size={14} /> : <IconPlay size={14} />}
              {music.playing ? t("pages.personalize.pause") : t("pages.personalize.play")}
            </button>
            <div className="slider">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                aria-label={t("pages.personalize.musicVolumeAria")}
                style={{ background: trackFill(volume) }}
                onChange={(event) => previewVolume(Number(event.target.value))}
                onPointerUp={commitVolume}
                onKeyUp={commitVolume}
              />
              <span className="slider-value">{pct(volume)}</span>
            </div>
          </div>

          <div className="media-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void openDir("music", t("pages.personalize.musicTitle"))}
            >
              <IconFolder size={14} />
              {t("pages.personalize.openFolder")}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={refreshMedia}>
              <IconRefresh size={14} />
              {t("pages.personalize.refreshMusic")}
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{t("pages.personalize.startupTitle")}</h2>
            <span className="panel-count">{t("pages.personalize.startupBadge")}</span>
          </div>

          <Field label={t("pages.personalize.startupLabel")} hint={t("pages.personalize.startupHint")}>
            <Select
              value={settings.startupSound}
              keepEmpty
              options={[
                { value: "off", label: t("pages.personalize.startupOff") },
                { value: "", label: t("pages.personalize.startupDefault") },
                ...tracks.map((name) => ({ value: name, label: mediaLabel(name) })),
              ]}
              ariaLabel={t("pages.personalize.startupAria")}
              placeholder={t("pages.personalize.startupDefault")}
              disabled={media.loading}
              onChange={pickStartupSound}
            />
          </Field>

          <div className="music-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void togglePreview()}>
              {previewing ? <IconPause size={14} /> : <IconPlay size={14} />}
              {previewing ? t("pages.personalize.stop") : t("pages.personalize.preview")}
            </button>
            <div className="slider">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={startupVolume}
                aria-label={t("pages.personalize.startupVolumeAria")}
                style={{ background: trackFill(startupVolume) }}
                onChange={(event) => setStartupVolume(Number(event.target.value))}
                onPointerUp={commitStartupVolume}
                onKeyUp={commitStartupVolume}
              />
              <span className="slider-value">{pct(startupVolume)}</span>
            </div>
          </div>

          <p className="field-hint">{t("pages.personalize.previewNote")}</p>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{t("pages.personalize.titlebarSection")}</h2>
            <span className="panel-count">{t("pages.personalize.instantApply")}</span>
          </div>

          <div className="titlebar-options" role="radiogroup" aria-label={t("pages.personalize.titlebarAria")}>
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
                  onClick={() => void persist({ titleBar: option.value }, t("pages.personalize.persistTitleBar"))}
                >
                  <span className={`radio-dot ${active ? "on" : ""}`} aria-hidden="true" />
                  <span className="source-text">
                    <span className="source-name">{t(option.labelKey)}</span>
                    <span className="source-desc">{t(option.hintKey)}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <Field label={t("pages.personalize.titleTextLabel")} hint={t("pages.personalize.titleTextHint")}>
            <TextInput
              value={titleDraft}
              placeholder={t("pages.personalize.titleTextPlaceholder")}
              aria-label={t("pages.personalize.titleTextAria")}
              maxLength={48}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitTitle();
              }}
            />
          </Field>

          <p className="field-hint">{t("pages.personalize.titlebarNote")}</p>
        </div>

        <div className="panel" data-icon-panel>
          <div className="panel-head">
            <h2 className="panel-title">{t("pages.personalize.iconSection")}</h2>
            <span className="panel-count">{t("pages.personalize.instantPreview")}</span>
          </div>

          {media.error ? <ErrorState message={media.error} onRetry={media.reload} /> : null}

          <div className="media-preview icon-preview">
            <img src={iconSrc(iconUrl)} alt={t("pages.personalize.iconPreviewAlt")} data-icon-preview />
            <span className="media-preview-name" data-icon-name>
              {settings.appIcon || t("pages.personalize.builtinLogoName")}
            </span>
          </div>

          {settings.appIcon && !iconUrl ? (
            <p className="field-hint" data-icon-missing>
              {t("pages.personalize.iconMissing")}
            </p>
          ) : null}

          <Field label={t("pages.personalize.iconLabel")} hint={t("pages.personalize.iconHint")}>
            <div className="icon-grid" role="radiogroup" aria-label={t("pages.personalize.iconAria")}>
              <button
                type="button"
                role="radio"
                aria-checked={settings.appIcon === ""}
                className={`icon-choice ${settings.appIcon === "" ? "active" : ""}`.trim()}
                data-icon-choice=""
                title={t("pages.personalize.useBuiltinLogo")}
                onClick={() => void pickIcon("")}
              >
                <img src={logo} alt="" />
                <span className="icon-filename">{t("pages.personalize.builtinDefault")}</span>
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
            {t("pages.personalize.iconNote")}
          </p>

          <div className="media-actions">
            <button type="button" className="btn btn-ghost btn-sm" data-action="open-icons" onClick={() => void openIconFolder()}>
              <IconFolder size={14} />
              {t("pages.personalize.openIcons")}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" data-action="refresh-icons" onClick={refreshIcons}>
              <IconRefresh size={14} />
              {t("pages.personalize.refresh")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
