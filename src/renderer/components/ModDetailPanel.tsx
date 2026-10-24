import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ModProviderId } from "../../shared/types";
import { api } from "../lib/api";
import { formatCount, formatDate } from "../lib/format";
import { useT } from "../lib/i18n";
import { errorMessage, useAsync } from "../lib/useAsync";
import { Drawer } from "./Drawer";
import { IconLink, IconSearch } from "./icons";
import { ImageLightbox } from "./ImageLightbox";
import { ErrorState, SkeletonRows } from "./State";
import { useToast } from "./Toast";

/** 平台展示名：Modrinth / CurseForge 是专有名词保持英文，麦块社区按界面语言翻译。 */
function providerName(id: ModProviderId, tr: (key: string, vars?: Record<string, string | number>) => string): string {
  if (id === "minekuai") return tr("pages.modDetail.providerMinekuai");
  return id === "modrinth" ? "Modrinth" : "CurseForge";
}

/**
 * MCMOD 站内搜索地址。关键词一律 encodeURIComponent：中文标题（如「物品管理器」）
 * 直接拼进 URL 会被浏览器/主进程截断或转义成乱码，搜索结果页就打不开了。
 * 导出是为了让桩测能单独断言这个拼接。
 */
export function mcmodSearchUrl(keyword: string): string {
  return "https://search.mcmod.cn/s?key=" + encodeURIComponent(keyword);
}

/** 版本标签最多展开 10 个，其余折叠成「+N」。 */
const VERSION_LIMIT = 10;

/**
 * 画廊：每张缩略图都包在原生 button 里（可 Tab 聚焦，Enter/Space 打开灯箱），
 * 点击后由 ImageLightbox 定位到同一份去重数组里的那一张，所以 index 始终对得上。
 * 「完整介绍」那边是纯文本渲染（没有 <img>），图片集合因此只有画廊本身。
 * 导出是为了让预览/SSR 能单独渲染它做断言；面板里只把它当普通组件用。
 */
export function ModGallery({
  images, altFor,
}: {
  images: string[];
  altFor: (index: number) => string;
}) {
  const tr = useT();
  const shots = useMemo(() => Array.from(new Set(images.filter(Boolean))), [images]);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (shots.length === 0) return null;

  return (
    <>
      <div className="mod-gallery" data-mod-gallery>
        {shots.map((shot, index) => (
          <button
            key={`${index}-${shot.slice(0, 24)}`}
            type="button"
            className="mod-gallery-btn"
            data-gallery-open={index}
            aria-haspopup="dialog"
            aria-label={altFor(index)}
            title={tr("lightbox.open")}
            onClick={() => setOpenIndex(index)}
          >
            <img className="mod-gallery-shot" src={shot} alt={altFor(index)} data-gallery-item loading="lazy" />
            <span className="mod-gallery-hint" aria-hidden="true">{tr("lightbox.open")}</span>
          </button>
        ))}
      </div>
      {openIndex === null ? null : (
        <ImageLightbox
          images={shots}
          index={openIndex}
          alt={altFor(openIndex)}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </>
  );
}

export function ModDetailPanel({
  open, provider, projectId, fallbackTitle, titleZh, summaryZh, onClose, filesSlot, installLabel,
  onInstall, installing, installingLabel, instanceName, installHint, noInstance, installDisabled, installTitle,
  targetKind = "instance",
}: {
  open: boolean;
  provider: ModProviderId;
  projectId: string;
  /** 详情回来之前先用搜索结果里的标题占位。 */
  fallbackTitle: string;
  /** 搜索结果里的中文译名（主进程实时翻译填充，可为空）。 */
  titleZh?: string;
  /** 搜索结果里的中文简介；有译文时优先显示。 */
  summaryZh?: string;
  onClose: () => void;
  /** 可用文件列表（安装单个文件的旧流程）由页面注入，保持原有能力。 */
  filesSlot?: ReactNode;
  /** 安装按钮文案按内容类型变化（模组/光影/资源包/整合包）。 */
  installLabel?: string;
  onInstall: () => void;
  installing: boolean;
  /** 没有可用目标时（插件还没选目标服务端 / 目标是模组服）把安装按钮禁掉。 */
  installDisabled?: boolean;
  /** 按钮的悬停说明（插件的平台不匹配、目标核心是模组服时写清楚原因）。 */
  installTitle?: string;
  /** 装到哪里：实例（默认）还是服务端。服务端下要额外看 mod 的 serverSide。 */
  targetKind?: "instance" | "server";
  /** 进行中的按钮文案（整合包是「正在创建实例…」）。 */
  installingLabel?: string;
  instanceName?: string;
  /** 覆盖「将安装到 X」这行说明（整合包是「将新建实例 X」）。 */
  installHint?: string;
  noInstance: boolean;
}) {
  const { push } = useToast();
  const tr = useT();
  const detail = useAsync(() => api.mods.detail(provider, projectId), [provider, projectId]);
  const data = detail.data;
  const sourceUrl = data?.sourceUrl ?? "";
  /** 「简介 / 完整介绍」各自记住看原文还是译文：默认译文，没有译文时自然显示原文。 */
  const [summaryLang, setSummaryLang] = useState<"zh" | "src">("zh");
  const [bodyLang, setBodyLang] = useState<"zh" | "src">("zh");
  /** 正文译文还在后台翻：详情页先显示原文并标「正在翻译…」，翻好后重取一次。 */
  const pendingBody = data?.translatePending === true;
  const [polls, setPolls] = useState(0);
  /** 详情自带译名优先，其次用搜索结果里的译名；都没有就保持原文。 */
  const zhTitle = data?.titleZh ?? titleZh;
  /** 简介译文：详情里的 summaryZh 优先，其次用搜索结果带过来的那份。 */
  const summaryZhText = data?.summaryZh || summaryZh || "";
  /** 完整介绍译文：后台翻完之前为空，此时两处都显示原文。 */
  const bodyZhText = data?.bodyZh ?? "";
  /**
   * 服务端目标下的「这个内容支不支持服务端」：unsupported 直接禁用按钮，
   * unknown / 没标注只提示（作者没写不代表一定不行）；实例目标不看这个字段。
   */
  const serverSide = data?.serverSide;
  const sideUnsupported = targetKind === "server" && serverSide === "unsupported";
  const sideUnknown = targetKind === "server" && (serverSide === "unknown" || serverSide === undefined);
  const sideRequired = targetKind === "server" && serverSide === "required";

  // 换项目就回到「默认看译文」，避免上一个模组的选择带到这一个
  useEffect(() => {
    setSummaryLang("zh");
    setBodyLang("zh");
    setPolls(0);
  }, [provider, projectId]);

  // 后台翻完的正文要重取一次详情才能看到；最多补取 3 次，翻不出来就一直显示原文
  useEffect(() => {
    if (!pendingBody || polls >= 3) return;
    const timer = setTimeout(() => {
      setPolls((count) => count + 1);
      detail.reload();
    }, 4_000);
    return () => clearTimeout(timer);
  }, [pendingBody, polls, detail.reload]);

  const openHome = async () => {
    if (!sourceUrl) return;
    try {
      await api.app.openExternal(sourceUrl);
      push(tr("pages.modDetail.openedHome"), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const copyLink = async () => {
    if (!sourceUrl) return;
    try {
      await api.app.copyText(sourceUrl);
      push(tr("pages.modDetail.copied"), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  /**
   * 搜索词：中文名优先（详情自带译名 → 搜索结果译名 → 原文标题）。
   * 详情还没回来、或回来但没有标题时为空，此时头部不出现 MCMOD 按钮。
   */
  const mcmodKey = (data?.titleZh || titleZh || data?.title || "").trim();

  const openMcmod = async () => {
    if (!mcmodKey) return;
    try {
      await api.app.openExternal(mcmodSearchUrl(mcmodKey));
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  /** 详情页头部「原始页面」：直接在浏览器打开这个资源的发布页（没有 sourceUrl 就不出现）。 */
  const openSourcePage = async () => {
    if (!sourceUrl) return;
    try {
      await api.app.openExternal(sourceUrl);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  /**
   * 头部动作：只给内容类详情（模组/插件/整合包/资源包/光影）用；本面板不承载地图。
   * 顺序即 DOM 顺序：「原始页面」在 MCMOD 搜索左边。
   */
  const headActions = data ? (
    <>
      {sourceUrl ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm mod-detail-source"
          onClick={() => void openSourcePage()}
          title={tr("pages.modDetail.openSourcePageHint", { url: sourceUrl })}
          aria-label={tr("pages.modDetail.openSourcePage")}
          data-action="open-source-page"
          data-source-url={sourceUrl}
        >
          <IconLink size={14} />
          <span className="mod-detail-source-label">{tr("pages.modDetail.openSourcePage")}</span>
        </button>
      ) : null}
      {mcmodKey ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm mod-detail-mcmod"
          onClick={() => void openMcmod()}
          title={tr("pages.modDetail.mcmodSearchHint", { name: mcmodKey })}
          aria-label={tr("pages.modDetail.mcmodSearchHint", { name: mcmodKey })}
          data-action="mcmod-search"
          data-mcmod-key={mcmodKey}
        >
          <IconSearch size={14} />
          <span className="mod-detail-mcmod-label">{tr("pages.modDetail.mcmodSearch")}</span>
        </button>
      ) : null}
    </>
  ) : null;

  const footer = data ? (
    <>
      <p className="mod-detail-foot-hint" data-install-hint>
        {installHint
          ?? (noInstance
            ? tr("pages.modDetail.noInstanceHint")
            : tr("pages.modDetail.installTo", { name: instanceName ?? "" }))}
      </p>
      <div className="mod-detail-foot-actions">
        <button type="button" className="btn btn-ghost" onClick={() => void openHome()} disabled={!sourceUrl} data-action="open-home">
          {tr("pages.modDetail.openHome")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void copyLink()} disabled={!sourceUrl} data-action="copy-link">
          {tr("pages.modDetail.copyLink")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onInstall}
          /* 这个按钮只负责「打开安装到…」：选目标之前不能判定这一单装不进服务端，
             所以服务端不支持只提示不禁用（禁用会让人连换目标的机会都没有）。 */
          disabled={installing || !data || installDisabled}
          title={sideUnsupported ? tr("pages.modDetail.serverUnsupported") : installTitle}
          data-action="install"
        >
          {installing ? (installingLabel ?? tr("pages.modDetail.installing")) : (installLabel ?? tr("pages.modDetail.installToCurrent"))}
        </button>
      </div>
    </>
  ) : null;

  return (
    <Drawer
      open={open}
      width={720}
      title={zhTitle ?? data?.title ?? fallbackTitle}
      subtitle={data ? `${providerName(data.provider, tr)} · ${data.author} · ${data.slug}` : undefined}
      headActions={headActions}
      onClose={onClose}
      footer={footer}
    >
      {detail.loading ? (
        <div className="mod-detail-loading" data-mod-detail-skeleton>
          <div className="mod-detail-hero-skeleton skeleton-row" />
          <SkeletonRows count={4} />
        </div>
      ) : null}

      {!detail.loading && detail.error ? (
        <ErrorState message={detail.error} onRetry={detail.reload} />
      ) : null}

      {data ? (
        <div className="mod-detail" data-mod-detail>
          <div className="mod-detail-hero">
            <img className="mod-detail-icon" src={data.iconUrl} alt="" width={64} height={64} loading="lazy" />
            <div className="mod-detail-hero-main">
              <h3 className="mod-detail-title">{zhTitle ?? data.title}</h3>
              {zhTitle && zhTitle !== data.title ? (
                <p className="mod-detail-title-orig" data-mod-detail-title-orig>{data.title}</p>
              ) : null}
              <p className="mod-detail-author">{data.author}</p>
              <div className="mod-detail-stats" data-mod-detail-fields>
                <span><b data-field="downloads">{formatCount(data.downloads, tr)}</b> {tr("pages.modDetail.downloads")}</span>
                <span><b data-field="followers">{data.followers ? formatCount(data.followers, tr) : "—"}</b> {tr("pages.modDetail.followers")}</span>
                <span><b data-field="license">{data.license ?? tr("pages.modDetail.unmarked")}</b> {tr("pages.modDetail.license")}</span>
                <span><b data-field="updatedAt">{data.updatedAt ? formatDate(data.updatedAt) : "—"}</b> {tr("pages.modDetail.lastUpdated")}</span>
              </div>
              {targetKind === "server" ? (
                sideUnsupported ? (
                  <p className="hint-inline plugin-side-warn" data-mod-server-unsupported>
                    {tr("pages.modDetail.serverUnsupported")}
                  </p>
                ) : sideUnknown ? (
                  <p className="hint-inline" data-mod-server-unknown>
                    {tr("pages.modDetail.serverUnknown")}
                  </p>
                ) : sideRequired ? (
                  <p className="hint-inline" data-mod-server-required>
                    {tr("pages.modDetail.serverRequired")}
                  </p>
                ) : null
              ) : null}
            </div>
          </div>

          <section className="mod-detail-section">
            <div className="mod-detail-tag-row">
              <span className="field-label">{tr("pages.modDetail.summary")}</span>
              {summaryZhText ? (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-action="summary-lang-zh"
                    aria-pressed={summaryLang === "zh"}
                    onClick={() => setSummaryLang("zh")}
                  >
                    {tr("pages.modDetail.showTranslated")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-action="summary-lang-src"
                    aria-pressed={summaryLang === "src"}
                    onClick={() => setSummaryLang("src")}
                  >
                    {tr("pages.modDetail.showSource")}
                  </button>
                </>
              ) : null}
            </div>
            {pendingBody ? (
              /* 轻量占位：只提示这一块在翻，面板其余部分照常可用 */
              <span className="hint-inline" data-detail-translating="summary">{tr("pages.modDetail.translating")}</span>
            ) : null}
            <p
              className="mod-detail-summary"
              data-mod-detail-summary
              data-detail-lang={summaryZhText && summaryLang === "zh" ? "zh" : "src"}
            >
              {summaryZhText && summaryLang === "zh" ? summaryZhText : data.summary}
            </p>
          </section>

          <section className="mod-detail-section">
            <div className="mod-detail-tag-row">
              <span className="field-label">{tr("pages.modDetail.fullDescription")}</span>
              {bodyZhText ? (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-action="body-lang-zh"
                    aria-pressed={bodyLang === "zh"}
                    onClick={() => setBodyLang("zh")}
                  >
                    {tr("pages.modDetail.showTranslated")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-action="body-lang-src"
                    aria-pressed={bodyLang === "src"}
                    onClick={() => setBodyLang("src")}
                  >
                    {tr("pages.modDetail.showSource")}
                  </button>
                </>
              ) : null}
            </div>
            {pendingBody ? (
              <span className="hint-inline" data-detail-translating="body">{tr("pages.modDetail.translating")}</span>
            ) : null}
            {/* 纯文本渲染：保留换行，不注入 HTML，避免介绍里的标签变成可执行内容。
                正文很长，滚动容器仍由 .mod-detail-body 负责（max-height + overflow-y）。 */}
            <div
              className="mod-detail-body"
              data-mod-detail-body
              data-detail-lang={bodyZhText && bodyLang === "zh" ? "zh" : "src"}
            >
              {bodyZhText && bodyLang === "zh" ? bodyZhText : data.body}
            </div>
          </section>

          <section className="mod-detail-section">
            <span className="field-label">{tr("pages.modDetail.tags")}</span>
            <div className="mod-detail-tags">
              <div className="mod-detail-tag-row">
                <span className="mod-detail-tag-label">{tr("pages.modDetail.categories")}</span>
                {data.categories.length > 0
                  ? data.categories.map((category) => <span key={category} className="chip chip-sm">{category}</span>)
                  : <span className="muted-text">{tr("pages.modDetail.uncategorized")}</span>}
              </div>
              <div className="mod-detail-tag-row">
                <span className="mod-detail-tag-label">{tr("pages.modDetail.gameVersions")}</span>
                {data.gameVersions.slice(0, VERSION_LIMIT).map((version) => (
                  <span key={version} className="chip chip-sm">{version}</span>
                ))}
                {data.gameVersions.length > VERSION_LIMIT ? (
                  <span className="chip chip-sm mod-detail-more" data-mod-versions-more>
                    +{data.gameVersions.length - VERSION_LIMIT}
                  </span>
                ) : null}
                {data.gameVersions.length === 0 ? <span className="muted-text">{tr("pages.modDetail.unmarked")}</span> : null}
              </div>
              <div className="mod-detail-tag-row">
                <span className="mod-detail-tag-label">{tr("pages.modDetail.loaders")}</span>
                {data.loaders.length > 0
                  ? data.loaders.map((loader) => <span key={loader} className="chip chip-sm">{loader}</span>)
                  : <span className="muted-text">{tr("pages.modDetail.anyLoader")}</span>}
              </div>
            </div>
          </section>

          {data.gallery.length > 0 ? (
            <section className="mod-detail-section">
              <span className="field-label">{tr("pages.modDetail.gallery")}</span>
              <ModGallery
                images={data.gallery}
                altFor={(index) => tr("pages.modDetail.galleryAlt", { index: index + 1 })}
              />
            </section>
          ) : null}
        </div>
      ) : null}

      {filesSlot}
    </Drawer>
  );
}
