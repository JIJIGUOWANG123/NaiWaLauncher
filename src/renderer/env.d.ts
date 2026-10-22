import type { NaiwaApi } from "../shared/ipc";

declare global {
  interface Window {
    /** 预加载脚本注入的接口；浏览器预览时为 undefined，此时走 mock。 */
    naiwa?: NaiwaApi;
  }
}
