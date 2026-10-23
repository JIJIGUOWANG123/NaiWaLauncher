// 登录类请求需要走「系统代理 + Windows 证书库」，而 Node 自带的 fetch 用的是内置 CA 包、
// 也不读系统代理设置：公司/校园网的 HTTPS 拦截会让它直接 "fetch failed"。
// 这里留一个注入点，由 main.ts（唯一允许 import electron 的地方）把 electron net.fetch 注入进来。
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

let impl: Fetcher | null = null;

/** 注入 Electron 的 net.fetch；传 null 退回全局 fetch（纯 Node 自检环境走这条）。 */
export function setSystemFetcher(fetcher: Fetcher | null): void {
  impl = fetcher;
}

/** 取当前可用的 fetcher：优先系统网络栈，没有就用 Node 的。 */
export function systemFetch(input: string, init?: RequestInit): Promise<Response> {
  return impl ? impl(input, init) : fetch(input, init);
}
