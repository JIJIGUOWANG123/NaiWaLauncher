import type { ReactNode } from "react";
import type { ModProviderId } from "../../shared/types";
import { api } from "../lib/api";
import { formatCount, formatDate } from "../lib/format";
import { errorMessage, useAsync } from "../lib/useAsync";
import { Drawer } from "./Drawer";
import { ErrorState, SkeletonRows } from "./State";
import { useToast } from "./Toast";

const PROVIDER_LABEL: Record<ModProviderId, string> = {
  modrinth: "Modrinth",
  curseforge: "CurseForge",
  minekuai: "麦块社区（中文）",
};

/** 版本标签最多展开 10 个，其余折叠成「+N」。 */
const VERSION_LIMIT = 10;

export function ModDetailPanel({
  open, provider, projectId, fallbackTitle, titleZh, summaryZh, onClose, filesSlot, installLabel,
  onInstall, installing, instanceName, noInstance,
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
  instanceName?: string;
  noInstance: boolean;
}) {
  const { push } = useToast();
  const detail = useAsync(() => api.mods.detail(provider, projectId), [provider, projectId]);
  const data = detail.data;
  const sourceUrl = data?.sourceUrl ?? "";
  /** 详情自带译名优先，其次用搜索结果里的译名；都没有就保持原文。 */
  const zhTitle = data?.titleZh ?? titleZh;

  const openHome = async () => {
    if (!sourceUrl) return;
    try {
      await api.app.openExternal(sourceUrl);
      push("已在系统浏览器中打开项目主页", "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const copyLink = async () => {
    if (!sourceUrl) return;
    try {
      await api.app.copyText(sourceUrl);
      push("项目链接已复制", "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const footer = data ? (
    <>
      <p className="mod-detail-foot-hint" data-install-hint>
        {noInstance
          ? "未选择实例：安装按钮不可用，请先在左侧「当前实例」里选一个。"
          : `将安装到「${instanceName ?? ""}」`}
      </p>
      <div className="mod-detail-foot-actions">
        <button type="button" className="btn btn-ghost" onClick={() => void openHome()} disabled={!sourceUrl} data-action="open-home">
          打开项目主页
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void copyLink()} disabled={!sourceUrl} data-action="copy-link">
          复制链接
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onInstall}
          disabled={noInstance || installing || !data}
          data-action="install"
        >
          {installing ? "安装中…" : (installLabel ?? "安装到当前实例")}
        </button>
      </div>
    </>
  ) : null;

  return (
    <Drawer
      open={open}
      width={720}
      title={zhTitle ?? data?.title ?? fallbackTitle}
      subtitle={data ? `${PROVIDER_LABEL[data.provider]} · ${data.author} · ${data.slug}` : undefined}
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
                <span><b data-field="downloads">{formatCount(data.downloads)}</b> 下载</span>
                <span><b data-field="followers">{data.followers ? formatCount(data.followers) : "—"}</b> 关注</span>
                <span><b data-field="license">{data.license ?? "未标注"}</b> 许可</span>
                <span><b data-field="updatedAt">{data.updatedAt ? formatDate(data.updatedAt) : "—"}</b> 最后更新</span>
              </div>
            </div>
          </div>

          <section className="mod-detail-section">
            <span className="field-label">简介</span>
            <p className="mod-detail-summary" data-mod-detail-summary>{summaryZh ?? data.summaryZh ?? data.summary}</p>
          </section>

          <section className="mod-detail-section">
            <span className="field-label">完整介绍</span>
            {/* 纯文本渲染：保留换行，不注入 HTML，避免介绍里的标签变成可执行内容。 */}
            <div className="mod-detail-body" data-mod-detail-body>{data.body}</div>
          </section>

          <section className="mod-detail-section">
            <span className="field-label">标签</span>
            <div className="mod-detail-tags">
              <div className="mod-detail-tag-row">
                <span className="mod-detail-tag-label">分类</span>
                {data.categories.length > 0
                  ? data.categories.map((category) => <span key={category} className="chip chip-sm">{category}</span>)
                  : <span className="muted-text">未分类</span>}
              </div>
              <div className="mod-detail-tag-row">
                <span className="mod-detail-tag-label">游戏版本</span>
                {data.gameVersions.slice(0, VERSION_LIMIT).map((version) => (
                  <span key={version} className="chip chip-sm">{version}</span>
                ))}
                {data.gameVersions.length > VERSION_LIMIT ? (
                  <span className="chip chip-sm mod-detail-more" data-mod-versions-more>
                    +{data.gameVersions.length - VERSION_LIMIT}
                  </span>
                ) : null}
                {data.gameVersions.length === 0 ? <span className="muted-text">未标注</span> : null}
              </div>
              <div className="mod-detail-tag-row">
                <span className="mod-detail-tag-label">加载器</span>
                {data.loaders.length > 0
                  ? data.loaders.map((loader) => <span key={loader} className="chip chip-sm">{loader}</span>)
                  : <span className="muted-text">通用</span>}
              </div>
            </div>
          </section>

          {data.gallery.length > 0 ? (
            <section className="mod-detail-section">
              <span className="field-label">画廊</span>
              <div className="mod-gallery" data-mod-gallery>
                {data.gallery.map((shot, index) => (
                  <img
                    key={`${index}-${shot.slice(0, 24)}`}
                    className="mod-gallery-shot"
                    src={shot}
                    alt={`画廊图片 ${index + 1}`}
                    data-gallery-item
                    loading="lazy"
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {filesSlot}
    </Drawer>
  );
}
