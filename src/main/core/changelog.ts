// 程序内的更新日志：直接读随程序分发的 CHANGELOG.md，不再在界面里硬编码一份（那样必然落后于发版）。
// 打包后是 <resources>/CHANGELOG.md（electron-builder 的 extraResources），开发态是仓库根的 CHANGELOG.md。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChangelogSection } from "../../shared/types";
import { logger } from "./logger";
import { getPaths } from "./paths";

const log = logger("changelog");

function candidates(): string[] {
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const list = [join(getPaths().root, "CHANGELOG.md")];
  if (res) list.unshift(join(res, "CHANGELOG.md"));
  return list;
}

/** 把 markdown 行清理成界面可直接展示的纯文本：去列表前缀、行内加粗与反引号。 */
function clean(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/**
 * 解析成 [{ version, lines }]，按文件里的顺序（新的在前）。
 * 只认 "## x.y.z" 这种二级标题；"### 小节" 当成一条分组标题并入 lines。
 */
export function parseChangelog(text: string): ChangelogSection[] {
  const out: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[1].trim();
      current = { version: /^[0-9]/.test(title) ? title : title || "未标注", lines: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;
    const sub = /^###\s+(.+?)\s*$/.exec(line);
    if (sub) {
      current.lines.push("〔" + sub[1].trim() + "〕");
      continue;
    }
    if (!/^\s*[-*+]\s+/.test(line)) continue;
    const text2 = clean(line);
    if (text2) current.lines.push(text2);
  }
  return out.filter((section) => section.lines.length > 0);
}

/** IPC app:changelog：默认给最近 3 段；文件缺失或损坏时返回空数组，界面自己降级。 */
export async function getChangelog(limit = 3): Promise<ChangelogSection[]> {
  for (const file of candidates()) {
    try {
      const text = await readFile(file, "utf8");
      const sections = parseChangelog(text.replace(/^\uFEFF/, ""));
      if (sections.length > 0) return sections.slice(0, Math.max(1, Math.trunc(limit)));
    } catch {
      // 换下一个候选路径（打包态缺失时回落到根目录的副本）
    }
  }
  log.warn("没有读到 CHANGELOG.md（打包时请确认 extraResources 里带上了它）");
  return [];
}
