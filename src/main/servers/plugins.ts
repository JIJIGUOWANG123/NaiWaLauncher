// 兼容层：服务端插件的真实实现已在 content.ts（与模组装进服务端共用一套落盘逻辑：
// 同 sha1 复用、重名加 (1)、下载进度进「管理」页），这里只保留原来的导出名字，
// 让旧调用方（register.ts 的 plugins:* 通道）行为完全不变。
//
// 插件只走 Modrinth 通道：麦块社区插件面板的 project_id 就是 Modrinth 项目 ID（见 mods/minekuai.ts）。
import type { InstalledModInfo } from "../../shared/types";
import type { ServerPluginInstallRequest, ServerPluginInstallResult } from "../../shared/ipc";
import {
  installServerContent, listServerContent, removeServerContent, serverContentDir,
} from "./content";

/** 服务端的插件目录（<serverDir>/plugins），不存在时创建。 */
export function pluginsDir(serverId: string): Promise<string> {
  return serverContentDir(serverId, "plugin");
}

/** 已装插件：plugins 目录下的 *.jar 列表（含 sha1）。 */
export function listServerPlugins(serverId: string): Promise<InstalledModInfo[]> {
  return listServerContent(serverId, "plugin");
}

/** 把某个插件装进服务端（下载到 <serverDir>/plugins）。 */
export function installPluginToServer(
  req: ServerPluginInstallRequest,
  signal?: AbortSignal,
): Promise<ServerPluginInstallResult> {
  return installServerContent({ ...req, kind: "plugin" }, signal);
}

/** 卸载：删掉 plugins 目录里的一个 .jar。 */
export function removeServerPlugin(serverId: string, fileName: string): Promise<void> {
  return removeServerContent(serverId, "plugin", fileName);
}
