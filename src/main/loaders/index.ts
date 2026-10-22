import type { LoaderKind, LoaderVersionInfo } from "../../shared/types";
import { logger } from "../core/logger";
import { installVersion, isVersionInstalled } from "../minecraft/install";
import { installFabricLoader, listFabricLoaders } from "./fabric";
import { installForgeLoader, listForgeLoaders } from "./forge";
import { installNeoForgeLoader, listNeoForgeLoaders } from "./neoforge";
import { assertLiteLoaderSupported, installLiteLoader, listLiteLoaderVersions } from "./liteloader";
import { installQuiltLoader, listQuiltLoaders } from "./quilt";

const log = logger("loaders");

export async function listLoaderVersions(mcVersion: string, loader: LoaderKind): Promise<LoaderVersionInfo[]> {
  switch (loader) {
    case "fabric":
      return listFabricLoaders(mcVersion);
    case "forge":
      return listForgeLoaders(mcVersion);
    case "neoforge":
      return listNeoForgeLoaders(mcVersion);
    case "quilt":
      return listQuiltLoaders(mcVersion);
    case "liteloader":
      return listLiteLoaderVersions(mcVersion);
    case "vanilla":
      return [{ loader: "vanilla", version: mcVersion, mcVersion, stable: true }];
    default:
      throw new Error("未知的加载器类型：" + String(loader));
  }
}

export async function installLoader(input: {
  mcVersion: string;
  loader: LoaderKind;
  loaderVersion?: string;
  /** 取消信号：整条加载器安装链路（含原版补齐）一起中断。 */
  signal?: AbortSignal;
}): Promise<{ versionId: string; loaderVersion: string }> {
  const { mcVersion, loader, signal } = input;

  if (loader === "vanilla") {
    const result = await installVersion(mcVersion, signal);
    return { versionId: result.versionId, loaderVersion: mcVersion };
  }

  // LiteLoader 版本范围先判：不支持的原版没必要装
  if (loader === "liteloader") assertLiteLoaderSupported(mcVersion);

  // 加载器安装器与 Fabric 启动都依赖原版 json + 客户端 jar
  if (!(await isVersionInstalled(mcVersion))) {
    log.info("原版 " + mcVersion + " 未安装，先安装原版");
    await installVersion(mcVersion, signal);
  }

  switch (loader) {
    case "fabric":
      return installFabricLoader(mcVersion, input.loaderVersion, signal);
    case "forge":
      return installForgeLoader(mcVersion, input.loaderVersion, signal);
    case "neoforge":
      return installNeoForgeLoader(mcVersion, input.loaderVersion, signal);
    case "quilt":
      return installQuiltLoader(mcVersion, input.loaderVersion, signal);
    case "liteloader":
      return installLiteLoader(mcVersion, input.loaderVersion, signal);
    default:
      throw new Error("未知的加载器类型：" + String(loader));
  }
}
