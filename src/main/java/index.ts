import type { InstalledJava, JavaRelease, JavaSourceId, JavaSourceProbe } from "../../shared/types";
import {
  invalidateJavaCache,
  listInstalledJava as scanInstalledJava,
  resolveJavaFor as pickJavaFor,
} from "./locate";
import { installJavaFrom, listJavaReleases as releasesOfSource, probeJavaSources } from "./sources";

/** 可下载的 JDK 版本；source 缺省取设置，"auto" 会先探测并挑最快的源。 */
export async function listJavaReleases(source?: JavaSourceId): Promise<JavaRelease[]> {
  return releasesOfSource(source);
}

/** 各下载源的探测结果（bellsoft / adoptium / tuna / zulu / oracle / dragonwell）。 */
export async function listJavaSources(): Promise<JavaSourceProbe[]> {
  return probeJavaSources();
}

export async function listInstalledJava(): Promise<InstalledJava[]> {
  return scanInstalledJava();
}

export async function installJava(
  major: number,
  version?: string,
  source?: JavaSourceId,
  signal?: AbortSignal,
): Promise<InstalledJava> {
  const result = await installJavaFrom(major, version, source, signal);
  invalidateJavaCache();
  return result;
}

export async function resolveJavaFor(mcVersion: string): Promise<string> {
  return pickJavaFor(mcVersion);
}
