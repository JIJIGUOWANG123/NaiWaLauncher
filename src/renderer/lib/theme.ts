import type { Settings, ThemeId } from "../../shared/types";

export type ThemeMode = "light" | "dark";

export interface ThemePreset {
  id: ThemeId;
  name: string;
  /** 强调色（按钮、高亮、选中态的主色） */
  color: string;
  mode: ThemeMode;
}

/** 15 套预设：龙猫蓝/甜柠青/小草绿/菠萝黄/橡木棕 为浅色系，玄素黑为深色，其余各自深浅但保持辨识度。 */
export const THEME_PRESETS: ThemePreset[] = [
  { id: "dragon", name: "龙猫蓝", color: "#4A9BF5", mode: "light" },
  { id: "lemon", name: "甜柠青", color: "#35C4A8", mode: "light" },
  { id: "grass", name: "小草绿", color: "#5FBF5F", mode: "light" },
  { id: "pineapple", name: "菠萝黄", color: "#E0A93B", mode: "light" },
  { id: "oak", name: "橡木棕", color: "#A9744F", mode: "light" },
  { id: "midnight", name: "玄素黑", color: "#2B2B33", mode: "dark" },
  // 滑稽彩 / 欧皇彩：固定单一主色，不走彩色渐变（见 paletteOf 的 gradient 选项）
  { id: "candy", name: "滑稽彩", color: "#6FCF97", mode: "light" },
  { id: "pink", name: "铁杆粉", color: "#F06E96", mode: "light" },
  { id: "mystery", name: "神秘紫", color: "#9B6BD6", mode: "dark" },
  { id: "lucky", name: "欧皇彩", color: "#FFC53D", mode: "dark" },
  { id: "autumn", name: "秋仪金", color: "#D98324", mode: "light" },
  { id: "orange", name: "活泼橙", color: "#F2792B", mode: "light" },
  { id: "red", name: "跳票红", color: "#E04B4B", mode: "dark" },
  { id: "geek", name: "极客蓝", color: "#4C6EF5", mode: "dark" },
  { id: "custom", name: "自定义", color: "#E0A93B", mode: "light" },
];

const CUSTOM_FALLBACK = "#4A9BF5";

export interface Palette {
  mode: ThemeMode;
  accent: string;
  accent2: string;
  accentInk: string;
  /** 按钮 / 标题栏 / 选中态统一的渐变；纯色主题下两个色标同色。 */
  accentGrad: string;
  /** 渐变结束色（界面在「跟随主题」时用它做取色器底色）。 */
  accentGradEnd: string;
  titleGrad: string;
  accentSoft: string;
  accentTint: string;
  onAccent: string;
  bg: string;
  bgSoft: string;
  bgOverlay: string;
  surface: string;
  surface2: string;
  surfaceHover: string;
  surfaceRecess: string;
  surfaceRecessStrong: string;
  surfaceGlass: string;
  overlayScrim: string;
  border: string;
  divider: string;
  text: string;
  textStrong: string;
  textDim: string;
  textFaint: string;
  sidebarBg: string;
  sidebarText: string;
  sidebarActiveBg: string;
  shadow: string;
  shadowSoft: string;
  shadowColor: string;
  ok: string;
  ok2: string;
  danger: string;
  danger2: string;
  info: string;
  info2: string;
  onInfo: string;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const toByte = (value: number): string => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");

export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

function rgbOf(hex: string): [number, number, number] {
  const source = (isHexColor(hex) ? hex.trim() : CUSTOM_FALLBACK).slice(1);
  return [parseInt(source.slice(0, 2), 16), parseInt(source.slice(2, 4), 16), parseInt(source.slice(4, 6), 16)];
}

function toHex(r: number, g: number, b: number): string {
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`.toUpperCase();
}

/** 与白色混合提亮。 */
export function lighten(hex: string, amount = 0.22): string {
  const mixed = rgbOf(hex).map((channel) => channel + (255 - channel) * amount);
  return toHex(mixed[0], mixed[1], mixed[2]);
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** CSS 现代语法用：rgb(var(--x-rgb) / alpha) 的空格分隔三元组。 */
export function rgbTriplet(hex: string): string {
  return rgbOf(hex).join(" ");
}

function relativeLuminance(hex: string): number {
  const linear = rgbOf(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const light = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const table: Array<[number, number, number]> = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r, g, b] = table[Math.floor(hue / 60) % 6];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

function hueSatLight(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = rgbOf(hex).map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

/** 把颜色朝明/暗方向调到与底色对比度达标（≥ minRatio），用于强调色文字与语义色。 */
function readableOn(base: string, against: string, mode: ThemeMode, minRatio = 4.6): string {
  const { h, s, l } = hueSatLight(base);
  let light = l;
  for (let step = 0; step < 40; step += 1) {
    const candidate = hslToHex(h, s, light);
    if (contrastRatio(candidate, against) >= minRatio) return candidate;
    light = mode === "light" ? light - 0.02 : light + 0.02;
    if (light <= 0.04 || light >= 0.98) break;
  }
  return mode === "light" ? hslToHex(h, s, 0.12) : hslToHex(h, s, 0.94);
}

/** 自定义主题按主色亮度决定明暗：亮主色配深底，暗主色配浅底。 */
export function customMode(accent: string): ThemeMode {
  return relativeLuminance(isHexColor(accent) ? accent : CUSTOM_FALLBACK) >= 0.45 ? "dark" : "light";
}

export function accentOf(theme: ThemeId, accentColor: string): string {
  if (theme === "custom") return isHexColor(accentColor) ? accentColor.trim().toUpperCase() : CUSTOM_FALLBACK;
  return THEME_PRESETS.find((preset) => preset.id === theme)?.color ?? CUSTOM_FALLBACK;
}

export interface ThemeGradientOptions {
  /** false（默认）时 --accent-grad 两个色标同色（视觉为纯色）。 */
  gradient?: boolean;
  /** 用户指定的渐变起始色（hex）；空串＝用主色。 */
  from?: string;
  /** 用户指定的渐变结束色（hex）；空串＝由主色推导。 */
  to?: string;
}

export interface PaletteOptions extends ThemeGradientOptions {
  /** 推导第二色标的方式：lighten = 提亮同色（预设主题）；hue = 色相旋转 +40°（自定义主题）。 */
  partner?: "lighten" | "hue";
  /** 未显式给 from/to 时该主题是否保持纯色（滑稽彩 / 欧皇彩沿用原观感）。 */
  flatDefault?: boolean;
}

/** 由「明暗 + 主色（+ 是否渐变）」推导整套调色板：底色、面板、边框、文字全部联动。 */
export function paletteOf(mode: ThemeMode, accentInput: string, options: PaletteOptions = {}): Palette {
  const gradient = options.gradient !== false;
  const partner = options.partner ?? "lighten";
  const accent = (isHexColor(accentInput) ? accentInput : CUSTOM_FALLBACK).toUpperCase();
  const { h, s } = hueSatLight(accent);
  const tint = mode === "dark" ? clamp(s * 0.42, 0.04, 0.28) : clamp(s * 0.36, 0.03, 0.26);

  const bg = mode === "dark" ? hslToHex(h, tint * 0.9, 0.09) : hslToHex(h, tint * 0.55, 0.96);
  const bgSoft = mode === "dark" ? hslToHex(h, tint * 0.85, 0.12) : hslToHex(h, tint * 0.45, 0.985);
  const surface = mode === "dark" ? hslToHex(h, tint, 0.135) : hslToHex(h, tint * 0.4, 0.995);
  const surface2 = mode === "dark" ? hslToHex(h, tint * 0.95, 0.18) : hslToHex(h, tint * 0.7, 0.94);
  const surfaceHover = mode === "dark" ? hslToHex(h, tint * 0.9, 0.23) : hslToHex(h, tint * 0.75, 0.9);
  const text = mode === "dark" ? hslToHex(h, Math.min(0.18, tint * 0.6), 0.92) : hslToHex(h, Math.min(0.3, tint * 1.1), 0.14);
  const textStrong = mode === "dark" ? hslToHex(h, Math.min(0.2, tint * 0.6), 0.97) : hslToHex(h, Math.min(0.34, tint * 1.2), 0.08);
  const sidebarBg = mode === "dark" ? hslToHex(h, tint * 0.95, 0.11) : hslToHex(h, tint * 0.6, 0.975);
  const onAccent = relativeLuminance(accent) > 0.25 ? hslToHex(h, Math.min(0.45, s), 0.12) : hslToHex(h, 0.18, 0.98);

  const accent2 = lighten(accent, 0.18);
  const { h: accentHue, s: accentSat, l: accentLight } = hueSatLight(accent);
  // 由主色推导的默认第二色标：自定义主题 +40° 色相旋转，预设主题提亮。
  const derivedEnd = partner === "hue" ? hslToHex(accentHue + 40, accentSat, accentLight) : accent2;
  const pickHex = (value?: string): string => (isHexColor(value ?? "") ? String(value).trim().toUpperCase() : "");
  const explicitFrom = pickHex(options.from);
  const explicitTo = pickHex(options.to);
  // 显式两色一律优先；只填一侧时另一侧按「起始色＝主色 / 结束色＝主色色相 +40°」推导；
  // 两侧都没填时：flatDefault 主题（滑稽彩 / 欧皇彩）退化为纯色，其它主题用 derivedEnd。
  const flatNoExplicit = options.flatDefault === true && !explicitFrom && !explicitTo;
  const gradStart = gradient ? (explicitFrom || accent) : accent;
  const gradEnd = !gradient
    ? accent
    : (explicitTo || (explicitFrom ? hslToHex(accentHue + 40, accentSat, accentLight) : (flatNoExplicit ? accent : derivedEnd)));
  const accentGrad = `linear-gradient(135deg, ${gradStart} 0%, ${gradEnd} 100%)`;
  // 文字色按「最不利」的底来校验：浅色主题用更暗的页面底色，深色主题用更亮的面板色
  const inkBase = mode === "light" ? bg : surface;
  const okBase = hslToHex(90, 0.5, mode === "dark" ? 0.62 : 0.4);
  const dangerBase = hslToHex(6, 0.66, mode === "dark" ? 0.62 : 0.46);
  const infoBase = hslToHex(212, 0.72, mode === "dark" ? 0.66 : 0.45);

  const accentInk = readableOn(accent, inkBase, mode, 4.8);
  // 自定义渐变时，标题渐变取用户两色的可读版本（对比度仍按页面底色校验）。
  const titleInkStart = gradient && explicitFrom ? readableOn(explicitFrom, inkBase, mode, 4.8) : accentInk;
  // 滑稽彩 / 欧皇彩在未显式配色时，标题也保持纯色。
  const titleFlat = !gradient || flatNoExplicit;
  const titleInkEnd = gradient && explicitTo
    ? readableOn(explicitTo, inkBase, mode, 4.8)
    : lighten(accentInk, mode === "dark" ? 0.25 : 0.08);

  return {
    mode,
    accent,
    accent2,
    accentInk,
    accentGrad,
    accentGradEnd: gradEnd,
    // 标题渐变跟随渐变开关：填了用户色就用它的「可读墨色」，否则用强调墨色；关闭时两端同色。
    titleGrad: titleFlat
      ? `linear-gradient(96deg, ${accentInk} 0%, ${accentInk} 100%)`
      : `linear-gradient(96deg, ${titleInkStart} 0%, ${titleInkStart} 55%, ${titleInkEnd} 100%)`,
    accentSoft: withAlpha(accent, 0.14),
    accentTint: withAlpha(accent, 0.32),
    onAccent,
    bg,
    bgSoft,
    bgOverlay: mode === "dark"
      ? "linear-gradient(180deg, rgba(6, 5, 4, 0.66) 0%, rgba(6, 5, 4, 0.46) 100%)"
      : "linear-gradient(180deg, rgba(255, 255, 255, 0.72) 0%, rgba(255, 255, 255, 0.52) 100%)",
    surface,
    surface2,
    surfaceHover,
    surfaceRecess: mode === "dark" ? "rgba(0, 0, 0, 0.34)" : "rgba(16, 24, 40, 0.05)",
    surfaceRecessStrong: mode === "dark" ? "rgba(0, 0, 0, 0.52)" : "rgba(16, 24, 40, 0.1)",
    surfaceGlass: withAlpha(mode === "dark" ? bgSoft : surface, 0.94),
    overlayScrim: mode === "dark" ? "rgba(6, 5, 4, 0.62)" : "rgba(16, 24, 40, 0.28)",
    border: withAlpha(text, mode === "dark" ? 0.1 : 0.13),
    divider: withAlpha(text, mode === "dark" ? 0.18 : 0.2),
    text,
    textStrong,
    textDim: withAlpha(text, 0.68),
    textFaint: withAlpha(text, mode === "dark" ? 0.56 : 0.66),
    sidebarBg,
    sidebarText: text,
    sidebarActiveBg: withAlpha(accent, mode === "dark" ? 0.2 : 0.16),
    shadow: mode === "dark" ? "0 18px 42px rgba(0, 0, 0, 0.46)" : "0 16px 38px rgba(16, 24, 40, 0.14)",
    shadowSoft: mode === "dark" ? "0 8px 22px rgba(0, 0, 0, 0.34)" : "0 6px 18px rgba(16, 24, 40, 0.1)",
    shadowColor: mode === "dark" ? "#000000" : "#101828",
    ok: readableOn(okBase, inkBase, mode, 4.8),
    ok2: readableOn(hslToHex(90, 0.5, mode === "dark" ? 0.5 : 0.3), inkBase, mode, 4.8),
    danger: readableOn(dangerBase, inkBase, mode, 4.8),
    danger2: readableOn(hslToHex(6, 0.66, mode === "dark" ? 0.5 : 0.36), inkBase, mode, 4.8),
    info: readableOn(infoBase, inkBase, mode, 4.8),
    info2: readableOn(hslToHex(212, 0.72, mode === "dark" ? 0.54 : 0.36), inkBase, mode, 4.8),
    onInfo: hslToHex(h, 0.2, 0.98),
  };
}

/** 当前主题下「渐变结束色」的推导值：界面在用户留空时用它做取色器底色。 */
export function derivedGradEnd(theme: ThemeId, accentColor: string): string {
  return paletteFor(theme, accentColor, { gradient: true }).accentGradEnd;
}

/** 渐变开关对全部主题生效：开启＝两色渐变（可用 gradientFrom/To 覆盖），关闭＝纯色。 */
export function paletteFor(theme: ThemeId, accentColor: string, options: ThemeGradientOptions = {}): Palette {
  const shared: ThemeGradientOptions = { gradient: options.gradient === true, from: options.from, to: options.to };
  if (theme === "custom") {
    const accent = isHexColor(accentColor) ? accentColor : CUSTOM_FALLBACK;
    return paletteOf(customMode(accent), accent, { ...shared, partner: "hue" });
  }
  const preset = THEME_PRESETS.find((item) => item.id === theme) ?? THEME_PRESETS[3];
  // 滑稽彩 / 欧皇彩：用户没显式指定两色时保持纯色观感。
  const flatDefault = preset.id === "candy" || preset.id === "lucky";
  return paletteOf(preset.mode, preset.color, { ...shared, partner: "lighten", flatDefault });
}

const TINT_KEY = "naiwa.bgTint";

/** 「叠加彩色背景」开关：契约里没有对应字段，按渲染层偏好存 localStorage。 */
export function readBgTint(): boolean {
  try {
    return localStorage.getItem(TINT_KEY) !== "off";
  } catch {
    return true;
  }
}

export function applyBgTint(on: boolean): void {
  document.documentElement.dataset.bgTint = on ? "on" : "off";
}

export function writeBgTint(on: boolean): void {
  try {
    localStorage.setItem(TINT_KEY, on ? "on" : "off");
  } catch {
    // 隐私模式下 localStorage 可能不可写，忽略即可。
  }
  applyBgTint(on);
}

export function applyUiOpacity(value: number): void {
  document.documentElement.style.setProperty("--ui-opacity", String(value));
}

/** 把整套调色板写成 CSS 变量；旧变量（--amber/--cream/--card/--line）一并指向新值。 */
export function applyTheme(
  settings: Pick<Settings, "theme" | "accentColor" | "uiOpacity"> & {
    customGradient?: boolean;
    gradientFrom?: string;
    gradientTo?: string;
  },
): Palette {
  const palette = paletteFor(settings.theme, settings.accentColor, {
    gradient: settings.customGradient === true,
    from: settings.gradientFrom,
    to: settings.gradientTo,
  });
  const style = document.documentElement.style;
  const set = (name: string, value: string) => style.setProperty(name, value);

  set("color-scheme", palette.mode);
  set("--accent", palette.accent);
  set("--accent-2", palette.accent2);
  set("--accent-grad", palette.accentGrad);
  set("--accent-ink", palette.accentInk);
  set("--title-grad", palette.titleGrad);
  set("--accent-soft", palette.accentSoft);
  set("--accent-tint", palette.accentTint);
  set("--on-accent", palette.onAccent);
  set("--bg", palette.bg);
  set("--bg-soft", palette.bgSoft);
  set("--bg-image-overlay", palette.bgOverlay);
  set("--bg-rgb", rgbTriplet(palette.bg));
  set("--surface", palette.surface);
  set("--surface-rgb", rgbTriplet(palette.surface));
  set("--surface-2", palette.surface2);
  set("--surface-2-rgb", rgbTriplet(palette.surface2));
  set("--surface-hover", palette.surfaceHover);
  set("--surface-recess", palette.surfaceRecess);
  set("--surface-recess-strong", palette.surfaceRecessStrong);
  set("--surface-glass", palette.surfaceGlass);
  set("--overlay-scrim", palette.overlayScrim);
  set("--border", palette.border);
  set("--divider", palette.divider);
  set("--text", palette.text);
  set("--text-strong", palette.textStrong);
  set("--text-dim", palette.textDim);
  set("--text-faint", palette.textFaint);
  set("--sidebar-bg", palette.sidebarBg);
  set("--sidebar-text", palette.sidebarText);
  set("--sidebar-active-bg", palette.sidebarActiveBg);
  set("--shadow", palette.shadow);
  set("--shadow-soft", palette.shadowSoft);
  set("--shadow-color", palette.shadowColor);
  set("--ok", palette.ok);
  set("--ok-2", palette.ok2);
  set("--danger", palette.danger);
  set("--danger-2", palette.danger2);
  set("--info", palette.info);
  set("--info-2", palette.info2);
  set("--on-info", palette.onInfo);

  // 兼容层：老样式里仍可能引用这些名字
  set("--amber", palette.accent);
  set("--cream", palette.accentInk);
  set("--card", palette.surface);
  set("--card-2", palette.surface2);
  set("--line", palette.border);
  set("--line-strong", palette.divider);
  set("--green", palette.ok);
  set("--red", palette.danger);
  set("--grad-warm", palette.accentGrad);

  applyUiOpacity(settings.uiOpacity);
  applyBgTint(readBgTint());
  return palette;
}
