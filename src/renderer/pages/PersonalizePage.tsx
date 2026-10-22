import { useEffect, useRef, useState } from "react";
import type { BackgroundMode, Settings, ThemeId, TitleBarStyle } from "../../shared/types";
import { api } from "../lib/api";
import { useApp } from "../lib/store";
import { usePersist } from "../lib/persist";
import { iconSrc, openIconsDir } from "../lib/appIcon";
import { BRAND_SUBTITLE_MAX, BRAND_TITLE_MAX, setBrandPreview } from "../lib/brand";
import { mediaLabel, mediaUrl } from "../lib/media";
import { pauseMusic, playMusic, setMusicVolume, useMusicState } from "../lib/music";
import { playPreviewSound, stopPreviewSound } from "../lib/startupSound";
import {
  THEME_PRESETS, accentOf, applyTheme, applyUiOpacity, derivedGradEnd, isHexColor, readBgTint, writeBgTint,
} from "../lib/theme";
import { BACKGROUND_INTERVAL_MAX, BACKGROUND_INTERVAL_MIN, clampInterval } from "../lib/background";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { Field, Select, TextInput, Toggle } from "../components/Form";
import { ErrorState, LoadingState } from "../components/State";
import { IconFolder, IconPause, IconPlay, IconRefresh } from "../components/icons";
import logo from "../assets/logo.png";

/** 系统标题栏已移除：只剩「精简」与「图片」两种自绘外观。 */
const TITLE_BARS: Array<{ value: TitleBarStyle; label: string; hint: string }> = [
  { value: "compact", label: "精简", hint: "40px 主题渐变细条，随主题色变化" },
  { value: "image", label: "图片", hint: "当前背景图做条底 + 半透明遮罩 + 主题色描边" },
];

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
  const music = useMusicState();
  const [opacity, setOpacity] = useState<number>(settings?.uiOpacity ?? 1);
  const [volume, setVolume] = useState<number>(settings?.musicVolume ?? 0.5);
  const [startupVolume, setStartupVolume] = useState<number>(settings?.startupVolume ?? 0.6);
  const [previewing, setPreviewing] = useState<boolean>(false);
  const [tint, setTint] = useState<boolean>(readBgTint);
  const [colorDraft, setColorDraft] = useState<string>(settings?.accentColor ?? "#E0A93B");
  const [titleDraft, setTitleDraft] = useState<string>(settings?.titleBarText ?? "");
  const [brandTitleDraft, setBrandTitleDraft] = useState<string>(settings?.brandTitle ?? "");
  const [brandSubtitleDraft, setBrandSubtitleDraft] = useState<string>(settings?.brandSubtitle ?? "");
  // 防抖保存要用「最新草稿」，不能靠 setTimeout 闭包里那次渲染的 state。
  const brandDraftRef = useRef({ title: brandTitleDraft, subtitle: brandSubtitleDraft });
  const brandTimer = useRef<number | null>(null);
  const [gradFromDraft, setGradFromDraft] = useState<string>(settings?.gradientFrom ?? "");
  const [gradToDraft, setGradToDraft] = useState<string>(settings?.gradientTo ?? "");
  const [intervalDraft, setIntervalDraft] = useState<string>(String(settings?.backgroundIntervalSec ?? 20));

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
    if (settings) setBrandTitleDraft(settings.brandTitle);
  }, [settings?.brandTitle]);

  useEffect(() => {
    if (settings) setBrandSubtitleDraft(settings.brandSubtitle);
  }, [settings?.brandSubtitle]);

  // 键盘输入即预览：侧边栏两行立刻跟着变，不需要等落盘。
  useEffect(() => {
    brandDraftRef.current = { title: brandTitleDraft, subtitle: brandSubtitleDraft };
    setBrandPreview({ title: brandTitleDraft, subtitle: brandSubtitleDraft });
  }, [brandTitleDraft, brandSubtitleDraft]);

  // 离开个性化页：撤掉草稿覆盖与未落盘的定时器，侧边栏回到已保存的文案。
  useEffect(() => () => {
    setBrandPreview(null);
    if (brandTimer.current !== null) window.clearTimeout(brandTimer.current);
  }, []);

  useEffect(() => {
    if (settings) setGradFromDraft(settings.gradientFrom);
  }, [settings?.gradientFrom]);

  useEffect(() => {
    if (settings) setGradToDraft(settings.gradientTo);
  }, [settings?.gradientTo]);

  useEffect(() => {
    if (settings) setIntervalDraft(String(settings.backgroundIntervalSec));
  }, [settings?.backgroundIntervalSec]);

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

  const clearBrandTimer = () => {
    if (brandTimer.current !== null) {
      window.clearTimeout(brandTimer.current);
      brandTimer.current = null;
    }
  };

  // 品牌文案：留空即「恢复默认」，所以 trim 后空串照常写库。
  const saveBrand = async (title: string, subtitle: string) => {
    clearBrandTimer();
    const nextTitle = title.trim();
    const nextSubtitle = subtitle.trim();
    const patch: Partial<Settings> = {};
    if (nextTitle !== (settings?.brandTitle ?? "")) patch.brandTitle = nextTitle;
    if (nextSubtitle !== (settings?.brandSubtitle ?? "")) patch.brandSubtitle = nextSubtitle;
    if (Object.keys(patch).length === 0) return;
    const saved = await persist(patch, "品牌文案");
    // 落盘后撤掉草稿，侧边栏改读回读后的设置值（内容相同，不会闪）。
    if (saved) setBrandPreview(null);
  };

  const scheduleBrandSave = () => {
    clearBrandTimer();
    brandTimer.current = window.setTimeout(() => {
      brandTimer.current = null;
      void saveBrand(brandDraftRef.current.title, brandDraftRef.current.subtitle);
    }, 600);
  };

  const commitBrand = () => void saveBrand(brandTitleDraft, brandSubtitleDraft);
  const resetBrandTitle = () => {
    setBrandTitleDraft("");
    void saveBrand("", brandSubtitleDraft);
  };
  const resetBrandSubtitle = () => {
    setBrandSubtitleDraft("");
    void saveBrand(brandTitleDraft, "");
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

  // 轮播间隔：5–600 秒，改完立即按新间隔重排定时器。
  const commitInterval = () => {
    const next = clampInterval(Number(intervalDraft));
    setIntervalDraft(String(next));
    if (next === settings?.backgroundIntervalSec) return;
    void persist({ backgroundIntervalSec: next }, "背景轮播间隔");
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

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">背景图片</h2>
            <span className="panel-count">NaiWa/backgrounds</span>
          </div>

          {media.loading ? <LoadingState label="读取背景图片…" /> : null}
          {media.error ? <ErrorState message={media.error} onRetry={media.reload} /> : null}

          {!media.loading && !media.error && backgrounds.length === 0 ? (
            <p className="media-empty">
              还没有背景图片：把 png / jpg / webp / gif / bmp 放进 NaiWa/backgrounds，再点下面的「刷新背景图片」。
            </p>
          ) : null}

          <Toggle
            label="叠加彩色背景"
            hint="开启时在背景图上再叠一层主题色蒙版，关闭则只保留深色蒙版"
            checked={tint}
            onChange={toggleTint}
          />

          <Field label="背景图" hint="支持 png / jpg / webp / gif / bmp，选中后立即铺满窗口">
            <Select
              value={settings.backgroundImage}
              options={backgrounds.map((name, index) => ({ value: name, label: mediaLabel(name, index) }))}
              placeholder="不使用背景图片"
              ariaLabel="背景图片"
              disabled={media.loading}
              onChange={pickBackground}
            />
          </Field>

          <Field label="播放方式" hint="单张＝只用所选图片；顺序轮播＝按文件名排序循环；随机轮播＝每次随机取，不连续重复">
            <Select
              value={settings.backgroundMode}
              options={BACKGROUND_MODES.map((item) => ({ value: item.value, label: item.label }))}
              ariaLabel="背景播放方式"
              disabled={backgrounds.length === 0}
              onChange={(value) => void persist({ backgroundMode: value as BackgroundMode }, "背景图片播放方式")}
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
                disabled={settings.backgroundMode === "single"}
                onChange={(event) => setIntervalDraft(event.target.value)}
                onBlur={commitInterval}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitInterval();
                }}
              />
              <span className="interval-unit">秒</span>
            </div>
          </Field>

          {bgUrl ? (
            <div className="media-preview">
              <img src={bgUrl} alt="背景图片预览" />
              <span className="media-preview-name">{mediaLabel(settings.backgroundImage)}</span>
            </div>
          ) : null}

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
        </div>

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

          <Field label="音效" hint="留空使用内置 bgm.mp3；把音频放进 NaiWa/music 后可在这里选择">
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
            <h2 className="panel-title">品牌与图标</h2>
            <span className="panel-count">即时预览</span>
          </div>

          <Field label="品牌主标题" hint={`侧边栏第一行；留空用默认「NaiWa」，最多 ${BRAND_TITLE_MAX} 字`}>
            <div className="input-with-action">
              <TextInput
                value={brandTitleDraft}
                placeholder="NaiWa"
                aria-label="品牌主标题"
                maxLength={BRAND_TITLE_MAX}
                data-brand-input="title"
                onChange={(event) => {
                  setBrandTitleDraft(event.target.value);
                  scheduleBrandSave();
                }}
                onBlur={commitBrand}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitBrand();
                }}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-action="reset-brand-title"
                disabled={brandTitleDraft === ""}
                onClick={resetBrandTitle}
              >
                恢复默认
              </button>
            </div>
          </Field>

          <Field label="品牌副标题" hint={`侧边栏第二行；留空用默认「奶娃启动器」，最多 ${BRAND_SUBTITLE_MAX} 字`}>
            <div className="input-with-action">
              <TextInput
                value={brandSubtitleDraft}
                placeholder="奶娃启动器"
                aria-label="品牌副标题"
                maxLength={BRAND_SUBTITLE_MAX}
                data-brand-input="subtitle"
                onChange={(event) => {
                  setBrandSubtitleDraft(event.target.value);
                  scheduleBrandSave();
                }}
                onBlur={commitBrand}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitBrand();
                }}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-action="reset-brand-subtitle"
                disabled={brandSubtitleDraft === ""}
                onClick={resetBrandSubtitle}
              >
                恢复默认
              </button>
            </div>
          </Field>

          {media.loading ? <LoadingState label="读取界面图标…" /> : null}
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

          <Field label="图标文件" hint="默认使用打包进启动器的 logo；选中 NaiWa/icons 里的文件后标题栏、侧边栏与启动画面即时换图">
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

          <p className="field-hint" data-brand-note>
            留空则使用默认文案；图标可选 NaiWa/icons 里的图片。
          </p>

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
