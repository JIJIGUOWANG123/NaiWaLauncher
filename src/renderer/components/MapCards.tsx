import type { MapEntry } from "../../shared/types";
import { formatBytes } from "../lib/format";
import { useT } from "../lib/i18n";
import { MAPS_LOGIN_HINT_KEY } from "../lib/modKind";
import { IconDownload, IconLink } from "./icons";

/**
 * 麦块社区地图卡片：纯展示，下载/打开网页由页面注入（都要走主进程 openExternal）。
 * compatible false 时给红色「不适配 <实例版本>」徽标；downloadUrl 为空时按钮禁用并提示登录。
 */
export function MapCards({
  entries, mcVersion, onDownload, onOpenWeb,
}: {
  entries: MapEntry[];
  /** 当前实例的游戏版本，用于「不适配 1.21.4」文案。 */
  mcVersion?: string;
  onDownload: (entry: MapEntry) => void;
  onOpenWeb: () => void;
}) {
  const t = useT();
  return (
    <div className="mod-grid map-grid">
      {entries.map((entry) => {
        const locked = !entry.downloadUrl;
        return (
          <article key={entry.id} className="map-card" data-map-card>
            {entry.coverUrl
              ? <img className="map-cover" src={entry.coverUrl} alt="" loading="lazy" />
              : <div className="map-cover map-cover-fallback" aria-hidden="true">{entry.title.slice(0, 1)}</div>}
            <div className="map-body">
              <div className="map-head">
                <h3 className="map-title" title={entry.title}>{entry.title}</h3>
                {entry.compatible === false ? (
                  <span className="badge map-badge-bad" data-map-incompatible>
                    {t("pages.maps.incompatible", { version: mcVersion ?? "" })}
                  </span>
                ) : null}
              </div>
              <p className="map-desc">{entry.description}</p>
              <div className="map-meta">
                <span className="chip chip-sm">{entry.category}</span>
                <span>{entry.author}</span>
                <span>{formatBytes(entry.fileSize)}</span>
              </div>
              <div className="map-versions" data-map-versions>
                <span className="map-versions-label">{t("pages.maps.versionsLabel")}</span>
                {entry.versions.length === 0
                  ? <span className="chip chip-sm">{t("pages.maps.noVersions")}</span>
                  : entry.versions.map((version) => <span key={version} className="chip chip-sm">{version}</span>)}
              </div>
              <div className="map-foot">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => onDownload(entry)}
                  disabled={locked}
                  data-action="download-map"
                >
                  <IconDownload size={15} />
                  {t("pages.maps.downloadToSaves")}
                </button>
                {locked ? (
                  <>
                    <span className="map-login-hint" data-map-login-hint>{t(MAPS_LOGIN_HINT_KEY)}</span>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={onOpenWeb} data-action="open-map-web">
                      <IconLink size={15} />
                      {t("pages.maps.openWeb")}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
