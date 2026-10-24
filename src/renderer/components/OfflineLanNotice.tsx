import { useState } from "react";
import type { InstalledContentRef, InstanceMeta, LoaderKind, ModFileInfo } from "../../shared/types";
import { api } from "../lib/api";
import { loaderLabel } from "../lib/format";
import { useT } from "../lib/i18n";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { IconAlert, IconCheck, IconInfo } from "../components/icons";

/**
 * Modrinth 上的 OfflineLAN（离线局域网）：让「对局域网开放」的服务器跳过正版验证。
 * /project/{id} 与 /project/{slug} 都能查版本文件，所以两个标识都留着，谁通就把谁缓存下来。
 */
const PROJECT_ID = "pimmstPB";
const PROJECT_SLUG = "offlinelan";

export type OfflineLanState = "no-instance" | "vanilla" | "missing" | "unsupported" | "ok";
/** host = 自己是房主（要自己装）；guest = 自己只是房客（让房主装/确认）。 */
export type OfflineLanSide = "host" | "guest";

export interface OfflineLanFacts {
  instance: Pick<InstanceMeta, "mcVersion" | "loader"> | null;
  /** 实例 mods 目录里是否已有 OfflineLAN（索引或扫描结果里有它）。 */
  installed: boolean;
  /** 已装文件自带的 MC 版本（offlinelan-2.0.0+1.21.4.jar → 1.21.4）；文件名里没有就是 null。 */
  installedMcVersion: string | null;
  /** 该项目在「当前 MC 版本 + 加载器」下有没有文件；null = 还没查出来或查询失败。 */
  available: boolean | null;
}

/**
 * 五种界面状态：没选实例 → 原版 → 已装且对得上 → 装不上（版本/加载器不匹配）→ 还没装。
 * 已装的情况先看文件名里的 MC 版本（装成别的版本等于没装对），再看站点上有没有当前版本的文件。
 */
export function resolveOfflineLanState(facts: OfflineLanFacts): OfflineLanState {
  const { instance } = facts;
  if (!instance) return "no-instance";
  if (instance.loader === "vanilla") return "vanilla";
  if (facts.installed) {
    if (facts.installedMcVersion && facts.installedMcVersion !== instance.mcVersion) return "unsupported";
    if (facts.available === false) return "unsupported";
    return "ok";
  }
  return facts.available === false ? "unsupported" : "missing";
}

/** Modrinth 的文件名是 <slug>-<模组版本>+<MC 版本>.jar：只认 + 后面那段，别把模组版本当游戏版本。 */
export function mcVersionFromFileName(fileName: string): string | null {
  const match = /\+\s*(\d+\.\d+(?:\.\d+)?)/.exec(fileName);
  return match ? match[1] : null;
}

/** 已装列表里挑 OfflineLAN：project_id / modId / 文件名（含分隔空格写法）三路都认。 */
export function isOfflineLanRef(ref: InstalledContentRef): boolean {
  if (ref.projectId === PROJECT_ID || ref.projectId === PROJECT_SLUG) return true;
  if (ref.modId && /offlinelan/i.test(ref.modId)) return true;
  const text = `${ref.fileName} ${ref.name ?? ""}`.toLowerCase();
  return text.includes("offlinelan") || text.includes("offline lan");
}

/** 解析过一次就记住可用的项目标识，之后每个 tab 只查一次文件列表。 */
let resolvedProjectId: string | null = null;

/** 查该项目在当前版本/加载器下的文件；两个标识都不通时返回 null（未知），不要当成「不支持」。 */
async function fetchProjectFiles(mcVersion: string, loader: LoaderKind): Promise<ModFileInfo[] | null> {
  const candidates = resolvedProjectId ? [resolvedProjectId] : [PROJECT_SLUG, PROJECT_ID];
  for (const projectId of candidates) {
    try {
      const files = await api.mods.files({
        provider: "modrinth", projectId, kind: "mod", gameVersion: mcVersion, loader,
      });
      resolvedProjectId = projectId;
      return files;
    } catch {
      // 换下一个标识再试；全都失败就交给调用方按「未知」处理。
    }
  }
  return null;
}

interface Probe {
  installed: boolean;
  installedMcVersion: string | null;
  available: boolean | null;
  projectId: string | null;
  fileId: string | null;
}

const EMPTY_PROBE: Probe = {
  installed: false, installedMcVersion: null, available: null, projectId: null, fileId: null,
};

/**
 * 三种联机方式共用的服主侧提示：版本匹配由「实例版本/加载器 + 站点文件列表 + 已装文件名」三方对照。
 * 只读渲染层已有能力（installedContent / files / install），不在主进程加查询。
 */
export function OfflineLanNotice({ side = "host" }: { side?: OfflineLanSide }) {
  const { currentInstance } = useApp();
  const t = useT();
  const { push } = useToast();
  const [installing, setInstalling] = useState(false);

  const probe = useAsync<Probe>(async () => {
    const instance = currentInstance;
    if (!instance || instance.loader === "vanilla") return EMPTY_PROBE;
    const [refs, files] = await Promise.all([
      // 已装列表查不到时按「没装」处理：状态照常显示，安装按钮重复点一次也不会坏。
      api.mods.installedContent(instance.id).catch(() => [] as InstalledContentRef[]),
      fetchProjectFiles(instance.mcVersion, instance.loader),
    ]);
    const ref = refs.find(isOfflineLanRef) ?? null;
    // exactMatch 是主进程按实例版本+加载器算好的，优先用它，否则取第一个可用文件。
    const file = files && files.length > 0 ? (files.find((item) => item.exactMatch) ?? files[0]) : null;
    return {
      installed: Boolean(ref),
      installedMcVersion: ref ? mcVersionFromFileName(ref.fileName) : null,
      available: files === null ? null : files.length > 0,
      projectId: files === null ? null : (resolvedProjectId ?? PROJECT_ID),
      fileId: file?.fileId ?? null,
    };
  }, [currentInstance?.id ?? "", currentInstance?.mcVersion ?? "", currentInstance?.loader ?? ""]);

  const facts: OfflineLanFacts = {
    instance: currentInstance,
    installed: probe.data?.installed ?? false,
    installedMcVersion: probe.data?.installedMcVersion ?? null,
    available: probe.data?.available ?? null,
  };
  const state = resolveOfflineLanState(facts);

  // 非原版实例要等第一次探测结果，否则会先闪一下「没装」；原版/未选实例不依赖网络，直接渲染。
  const skipProbe = !currentInstance || currentInstance.loader === "vanilla";
  if (!skipProbe && !probe.data) return null;

  const runInstall = async () => {
    const instance = currentInstance;
    if (!instance) return;
    setInstalling(true);
    try {
      // 走现有安装队列：同一个 api.mods.install，装完会出现在「管理」页。
      const result = await api.mods.install({
        provider: "modrinth",
        projectId: probe.data?.projectId ?? PROJECT_ID,
        fileId: probe.data?.fileId ?? undefined,
        instanceId: instance.id,
        kind: "mod",
        installDependencies: true,
      });
      push(t("pages.offlineLan.installDone", { file: result.fileName }), "success");
      probe.reload();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setInstalling(false);
    }
  };

  const loader = currentInstance ? loaderLabel(currentInstance.loader, t) : "";
  const mcVersion = currentInstance?.mcVersion ?? "";

  const body = (() => {
    if (state === "no-instance") {
      return (
        <>
          <span className="net-offlinelan-title">{t("pages.offlineLan.noInstanceTitle")}</span>
          <span className="net-offlinelan-hint">{t("pages.offlineLan.noInstanceBody")}</span>
        </>
      );
    }
    if (state === "vanilla") {
      return (
        <>
          <span className="net-offlinelan-title">{t("pages.offlineLan.vanillaTitle")}</span>
          <span className="net-offlinelan-hint">{t("pages.offlineLan.vanillaBody")}</span>
        </>
      );
    }
    if (state === "unsupported") {
      const installedElsewhere = probe.data?.installedMcVersion
        && probe.data.installedMcVersion !== mcVersion;
      return (
        <>
          <span className="net-offlinelan-title">
            {t("pages.offlineLan.unsupportedTitle", { version: mcVersion, loader })}
          </span>
          <span className="net-offlinelan-hint">
            {installedElsewhere
              ? t("pages.offlineLan.unsupportedInstalled", { installedVersion: probe.data?.installedMcVersion ?? "" })
              : t("pages.offlineLan.unsupportedBody")}
          </span>
          {installedElsewhere ? (
            <span className="net-offlinelan-hint">{t("pages.offlineLan.unsupportedBody")}</span>
          ) : null}
          {side === "guest" ? (
            <span className="net-offlinelan-hint">{t("pages.offlineLan.guestHostHint")}</span>
          ) : null}
        </>
      );
    }
    if (state === "ok") {
      return (
        <span className="net-offlinelan-title">
          {t(side === "guest" ? "pages.offlineLan.installedGuest" : "pages.offlineLan.installed")}
        </span>
      );
    }
    const failed = probe.data?.available === null && !probe.loading;
    return (
      <>
        <span className="net-offlinelan-title">
          {t(side === "guest" ? "pages.offlineLan.guestMissingTitle" : "pages.offlineLan.missingTitle")}
        </span>
        <span className="net-offlinelan-hint">
          {t(side === "guest" ? "pages.offlineLan.guestMissingBody" : "pages.offlineLan.missingBody")}
        </span>
        {side === "guest" ? (
          <span className="net-offlinelan-hint">{t("pages.offlineLan.guestDoNotInstall")}</span>
        ) : (
          <>
            <span className="net-offlinelan-hint">{t("pages.offlineLan.missingGuestHint")}</span>
            {failed ? <span className="net-offlinelan-hint">{t("pages.offlineLan.checkFailed")}</span> : null}
            <div className="net-offlinelan-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-action="install-offlinelan"
                onClick={() => void runInstall()}
                disabled={installing || probe.loading}
              >
                {installing ? t("pages.offlineLan.installing") : t("pages.offlineLan.install")}
              </button>
              {failed ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => probe.reload()}>
                  {t("pages.offlineLan.retry")}
                </button>
              ) : null}
            </div>
          </>
        )}
      </>
    );
  })();

  const icon = state === "ok" ? <IconCheck size={15} />
    : state === "vanilla" || state === "unsupported" ? <IconAlert size={15} />
      : <IconInfo size={15} />;

  return (
    <div
      className={`net-offlinelan is-${state}`}
      data-offlinelan-state={state}
      data-offlinelan-side={side}
      data-offlinelan-installed={probe.data?.installed ? "true" : "false"}
      data-offlinelan-mc={mcVersion}
      data-offlinelan-loader={currentInstance?.loader ?? ""}
      data-offlinelan-available={probe.data?.available === null || probe.data === null
        ? "unknown"
        : probe.data.available ? "true" : "false"}
      data-offlinelan-project={probe.data?.projectId ?? ""}
      data-offlinelan-file={probe.data?.fileId ?? ""}
    >
      {icon}
      <div className="net-offlinelan-body">{body}</div>
    </div>
  );
}
