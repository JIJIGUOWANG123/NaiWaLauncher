import type { ComponentType } from "react";
import { useApp, type PageId } from "../lib/store";
import { useTasks } from "../lib/tasks";
import { isMockApi } from "../lib/api";
import { useT } from "../lib/i18n";
import { IconDownload, IconInfo, IconInstances, IconJava, IconList, IconMods, IconPalette, IconRocket, IconSettings, IconSkin, IconSliders, IconUser, IconWifi, IconZap } from "./icons";

interface NavItem {
  id: PageId;
  /** i18n key：导航名随界面语言切换。 */
  labelKey: string;
  Icon: ComponentType<{ size?: number }>;
}

const NAV: NavItem[] = [
  { id: "instances", labelKey: "nav.instances", Icon: IconInstances },
  { id: "servers", labelKey: "nav.servers", Icon: IconZap },
  { id: "accounts", labelKey: "nav.accounts", Icon: IconUser },
  { id: "skins", labelKey: "nav.skins", Icon: IconSkin },
  { id: "download", labelKey: "nav.download", Icon: IconDownload },
  { id: "downloads", labelKey: "nav.downloads", Icon: IconList },
  { id: "mods", labelKey: "nav.mods", Icon: IconMods },
  { id: "net", labelKey: "nav.net", Icon: IconWifi },
  { id: "java", labelKey: "nav.java", Icon: IconJava },
  { id: "personalize", labelKey: "nav.personalize", Icon: IconPalette },
  { id: "launch", labelKey: "nav.launch", Icon: IconRocket },
  { id: "other", labelKey: "nav.other", Icon: IconSliders },
  { id: "about", labelKey: "nav.about", Icon: IconInfo },
  { id: "settings", labelKey: "nav.settings", Icon: IconSettings },
];

export function Sidebar() {
  const { page, navigate, info, update } = useApp();
  const { runningCount } = useTasks();
  const tr = useT();

  return (
    <aside className="sidebar">
      <nav className="nav" aria-label={tr("nav.main")}>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item ${page === item.id ? "active" : ""}`}
            aria-current={page === item.id ? "page" : undefined}
            onClick={() => navigate(item.id)}
          >
            <span className="nav-icon">
              <item.Icon size={19} />
            </span>
            <span>{tr(item.labelKey)}</span>
            {item.id === "instances" && runningCount > 0 ? <span className="nav-dot" aria-hidden="true" /> : null}
            {item.id === "about" && update?.hasUpdate ? (
              <span className="nav-badge" data-nav-update title={tr("shell.updateTitle", { version: update.latest ?? "" })}>
                {tr("shell.updateBadge")}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        {isMockApi
          ? <span className="mock-badge">{tr("shell.mock")}</span>
          : <span className="mock-badge live">{tr("shell.live")}</span>}
        <span className="version-line">
          {info ? `v${info.version}` : "v0.1.5"}
          {update?.hasUpdate ? (
            <button
              type="button"
              className="version-dot"
              data-version-dot
              title={tr("shell.updateHint", { version: update.latest ?? "" })}
              aria-label={tr("shell.updateHint", { version: update.latest ?? "" })}
              onClick={() => navigate("about")}
            />
          ) : null}
        </span>
      </div>
    </aside>
  );
}
