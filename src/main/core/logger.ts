import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

import type { LogLine } from "../../shared/types";
import { getPaths } from "./paths";

let sink: ((line: LogLine) => void) | null = null;
let fileStream: { day: string; stream: WriteStream } | null = null;

const secrets = new Set<string>();

/** 注册敏感值（如 CurseForge Key），日志里出现时统一替换为 7550…14bf。 */
export function registerSecret(value: string): void {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length >= 8) secrets.add(trimmed);
}

function maskSecrets(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(`${secret.slice(0, 4)}…${secret.slice(-4)}`);
  }
  return out;
}

export function setLogSink(next: (l: LogLine) => void): void {
  sink = next;
}

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function currentStream(day: string): WriteStream | null {
  if (fileStream && fileStream.day === day && !fileStream.stream.destroyed) return fileStream.stream;
  try {
    const dir = getPaths().logs;
    mkdirSync(dir, { recursive: true });
    fileStream?.stream.end();
    const stream = createWriteStream(join(dir, `launcher-${day}.log`), { flags: "a", encoding: "utf8" });
    // 磁盘写失败不能影响启动器主流程
    stream.on("error", () => {
      if (fileStream?.stream === stream) fileStream = null;
    });
    fileStream = { day, stream };
    return stream;
  } catch {
    return null;
  }
}

function writeFileLine(text: string): void {
  // paths 未初始化时（启动极早期）只走控制台，避免抛错
  try {
    const day = dayKey(new Date());
    currentStream(day)?.write(text + "\n");
  } catch {
    /* 忽略 */
  }
}

function emit(level: LogLine["level"], scope: string, msg: string): void {
  const time = Date.now();
  const safeMsg = maskSecrets(msg);
  writeFileLine(`[${new Date(time).toISOString()}] [${level.toUpperCase()}] [${scope}] ${safeMsg}`);

  const line: LogLine = { level, message: `[${scope}] ${safeMsg}`, time };
  try {
    sink?.(line);
  } catch {
    /* 渲染进程通道断开时不影响主流程 */
  }

  if (level === "error") console.error(line.message);
  else if (level === "warn") console.warn(line.message);
  else console.log(line.message);
}

export function logger(scope: string): { info(msg: string): void; warn(msg: string): void; error(msg: string): void } {
  return {
    info: (msg: string) => emit("info", scope, msg),
    warn: (msg: string) => emit("warn", scope, msg),
    error: (msg: string) => emit("error", scope, msg),
  };
}
