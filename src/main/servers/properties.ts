import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ServerMeta } from "../../shared/types";

export const PROPERTIES_FILE = "server.properties";
const HEADER = "#Minecraft server properties";

export type PropertyUpdates = Record<string, string | number | boolean>;

function renderValue(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * 覆盖指定键，同时保留用户手改过的内容（注释、顺序、其它键）。
 * 新建时没有旧文件，就以 Minecraft 自己的表头起头。
 */
export function mergeProperties(existing: string | null, updates: PropertyUpdates): string {
  const lines = (existing ?? "").split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) lines.push(HEADER);

  const pending = new Map<string, string>();
  for (const [key, value] of Object.entries(updates)) pending.set(key, renderValue(value));

  const out = lines.map((line) => {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1];
    const next = pending.get(key);
    if (next === undefined) return line;
    pending.delete(key);
    return `${key}=${next}`;
  });
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  return out.join("\n") + "\n";
}

/** 新建服务端时的基础项；其余键由服务端首次启动自己补齐。 */
export function defaultProperties(
  meta: Pick<ServerMeta, "name" | "port" | "maxPlayers" | "onlineMode">,
): PropertyUpdates {
  return {
    "server-port": meta.port,
    "max-players": meta.maxPlayers,
    "online-mode": meta.onlineMode,
    motd: meta.name,
    "level-name": "world",
    "enable-rcon": false,
    "view-distance": 10,
  };
}

/** update 时只覆盖用户能改的那几项，level-name / 视图距离留给他自己在文件里改。 */
export function editableProperties(
  meta: Pick<ServerMeta, "name" | "port" | "maxPlayers" | "onlineMode">,
): PropertyUpdates {
  return {
    "server-port": meta.port,
    "max-players": meta.maxPlayers,
    "online-mode": meta.onlineMode,
    motd: meta.name,
  };
}

export async function readProperties(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, PROPERTIES_FILE), "utf8");
  } catch {
    return null;
  }
}

/** 原子写：先落 .tmp 再 rename，避免半截文件被服务端读到。 */
export async function writeProperties(dir: string, updates: PropertyUpdates): Promise<void> {
  const file = join(dir, PROPERTIES_FILE);
  const text = mergeProperties(await readProperties(dir), updates);
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}
