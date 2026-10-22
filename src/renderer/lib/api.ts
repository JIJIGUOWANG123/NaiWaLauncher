import type { NaiwaApi } from "../../shared/ipc";
import { createMockApi } from "../mock/api";

function resolve(): { api: NaiwaApi; mock: boolean } {
  const injected = typeof window === "undefined" ? undefined : window.naiwa;
  if (injected) return { api: injected, mock: false };
  return { api: createMockApi(), mock: true };
}

const resolved = resolve();

/** 唯一 API 入口：Electron 下用 window.naiwa，浏览器预览下用内置 mock。 */
export const api: NaiwaApi = resolved.api;
/** 当前是否运行在 mock 模式（界面上一行提示用）。 */
export const isMockApi = resolved.mock;
