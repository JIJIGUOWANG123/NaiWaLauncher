import net from "node:net";
import { networkInterfaces } from "node:os";
import type { LanAddress, PortProbeResult } from "../../shared/types";
import { mt } from "../core/i18n";

/** 虚拟网卡名（VMware / VirtualBox / Hyper-V / vEthernet / Loopback 等）不作为联机地址展示。 */
const VIRTUAL_ADAPTER = /vmware|virtualbox|vbox|hyper-?v|vethernet|loopback/i;

const MIN_PORT = 1;
const MAX_PORT = 65535;
const DEFAULT_PROBE_TIMEOUT_MS = 4000;

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

/** 把 socket 错误码翻译成用户能看懂的说明。 */
function describeSocketError(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case "ECONNREFUSED": return mt("net.errRefused");
    case "ENOTFOUND": return mt("net.errDns");
    case "EHOSTUNREACH": return mt("net.errHostUnreach");
    case "ENETUNREACH": return mt("net.errNetUnreach");
    case "ETIMEDOUT": return mt("net.errTimeout");
    case "EACCES": return mt("net.errNoPermission");
    default: return err.message || mt("net.errConnectFailed");
  }
}

/** 本机可用局域网地址：跳过 internal 与常见虚拟网卡，按网卡名排序。 */
export async function listLanAddresses(): Promise<LanAddress[]> {
  const out: LanAddress[] = [];
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    if (!infos || VIRTUAL_ADAPTER.test(name)) continue;
    for (const info of infos) {
      if (info.internal) continue;
      if (info.family !== "IPv4" && info.family !== "IPv6") continue;
      const family: "IPv4" | "IPv6" = info.family === "IPv6" ? "IPv6" : "IPv4";
      out.push({ name, address: info.address, family });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

/**
 * TCP 探测 host:port 是否可连。
 * 参数不合法时不抛异常，而是回一条可读的失败结果，方便 IPC 直接透传给界面。
 */
export async function probeTcp(host: string, port: number, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<PortProbeResult> {
  const target = String(host ?? "").trim();
  if (!target) return { ok: false, latencyMs: null, error: mt("net.hostRequired") };
  if (!validPort(port)) return { ok: false, latencyMs: null, error: mt("net.badPort", { port: String(port) }) };

  return await new Promise<PortProbeResult>((resolve) => {
    const socket = new net.Socket();
    const startedAt = Date.now();
    let settled = false;

    const finish = (result: PortProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(Math.max(1, Math.floor(Number(timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS)));
    socket.once("connect", () => finish({ ok: true, latencyMs: Date.now() - startedAt }));
    socket.once("timeout", () => finish({ ok: false, latencyMs: null, error: mt("net.errTimeout") }));
    socket.once("error", (err: NodeJS.ErrnoException) => finish({ ok: false, latencyMs: null, error: describeSocketError(err) }));
    socket.connect(port, target);
  });
}

/** 本机 127.0.0.1:port 是否已被监听（用来判断游戏里是否已经开放了局域网房间）。 */
export async function isPortListening(port: number): Promise<boolean> {
  if (!validPort(port)) return false;
  const result = await probeTcp("127.0.0.1", port, 1500);
  return result.ok;
}
