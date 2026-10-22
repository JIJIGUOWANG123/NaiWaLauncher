// rules 过滤与参数模板替换：安装和启动都要用同一套 OS/features 判定，放一处避免漂移。
import { arch as osArch, release as osRelease } from "node:os";

export interface RuleOs {
  name?: string;
  arch?: string;
  version?: string;
}

export interface VersionRule {
  action: "allow" | "deny";
  os?: RuleOs;
  features?: Record<string, boolean>;
}

/** 启动器支持的 features，全部关闭：不做 demo/自定义分辨率/快速游玩。 */
export const LAUNCH_FEATURES: Record<string, boolean> = {
  is_demo_user: false,
  has_custom_resolution: false,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false,
};

type NodeArch = "x64" | "x86" | "arm64" | "other";

function currentArch(): NodeArch {
  const arch = osArch();
  if (arch === "x64") return "x64";
  if (arch === "ia32") return "x86";
  if (arch === "arm64") return "arm64";
  return "other";
}

function archMatches(ruleArch: string): boolean {
  const mine = currentArch();
  // Java 里的 os.arch 用 x86 表示 32 位，规则里偶尔会写 x86_64
  if (ruleArch === "x86") return mine === "x86";
  if (ruleArch === "x86_64") return mine === "x64";
  return ruleArch === mine;
}

function osMatches(os: RuleOs): boolean {
  if (os.name && os.name !== "windows") return false;
  if (os.arch && !archMatches(os.arch)) return false;
  if (os.version) {
    try {
      if (!new RegExp(os.version).test(osRelease())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 按 rules 判定一个库/参数项是否生效；无 rules 视为生效，deny 优先于 allow。 */
export function rulesAllow(rules?: VersionRule[], features: Record<string, boolean> = LAUNCH_FEATURES): boolean {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!rule) continue;
    if (rule.os && !osMatches(rule.os)) continue;
    if (rule.features && !Object.entries(rule.features).every(([key, want]) => Boolean(features[key]) === want)) continue;
    allowed = rule.action !== "deny";
  }
  return allowed;
}

/**
 * 现代版本把原生库写成带分类器的独立库（natives-windows / -arm64 / -x86），
 * 它们的 rules 只写了 os.name，必须自己按 CPU 架构挑出唯一那个。
 */
export function nativesClassifierAllowed(name: string): boolean {
  const classifier = String(name ?? "").split(":")[3];
  if (!classifier || !classifier.startsWith("natives-")) return true;
  const mine = currentArch();
  if (classifier.endsWith("-arm64")) return mine === "arm64";
  if (classifier.endsWith("-x86") || classifier.endsWith("-32")) return mine === "x86";
  return mine !== "x86";
}

/** Maven 坐标转库内相对路径，name 形如 group:artifact:version[:classifier][@ext]。 */
export function mavenPathOf(name: string): string {
  const [coordinate, ext] = name.split("@");
  const parts = coordinate.split(":");
  const group = parts[0] ?? "";
  const artifact = parts[1] ?? "";
  const version = parts[2] ?? "";
  const classifier = parts[3];
  const extension = ext && ext.length > 0 ? ext : "jar";
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ""}.${extension}`;
  return `${group.split(".").join("/")}/${artifact}/${version}/${file}`;
}

const PLACEHOLDER = /\$\{([^}]+)\}/g;

/** 替换 ${var} 模板；未知变量替换为空串，由调用方决定是否告警。 */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => (key in vars ? vars[key] : ""));
}

/** 列出模板里没有对应变量的占位符，用于启动前自检。 */
export function missingPlaceholders(template: string, vars: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const key = match[1];
    if (!(key in vars)) missing.add(key);
  }
  return [...missing];
}

/** 按空白切分参数串，支持单双引号包裹的整段参数。 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) out.push(current);
  return out;
}
