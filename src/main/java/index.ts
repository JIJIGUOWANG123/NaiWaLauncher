import type { InstalledJava, JavaRelease } from "../../shared/types";
import { install, listReleases } from "./liberica";
import {
  invalidateJavaCache,
  listInstalledJava as scanInstalledJava,
  resolveJavaFor as pickJavaFor,
} from "./locate";

export async function listJavaReleases(): Promise<JavaRelease[]> {
  return listReleases();
}

export async function listInstalledJava(): Promise<InstalledJava[]> {
  return scanInstalledJava();
}

export async function installJava(major: number, version: string, signal?: AbortSignal): Promise<InstalledJava> {
  const result = await install(major, version, signal);
  invalidateJavaCache();
  return result;
}

export async function resolveJavaFor(mcVersion: string): Promise<string> {
  return pickJavaFor(mcVersion);
}
