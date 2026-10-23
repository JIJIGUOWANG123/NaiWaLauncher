import type { ComponentType } from "react";
import { useApp, type PageId } from "../lib/store";
import { useTasks } from "../lib/tasks";
import { isMockApi } from "../lib/api";
import { IconDownload, IconInfo, IconInstances, IconJava, IconList, IconMods, IconPalette, IconRocket, IconSettings, IconSliders, IconUser, IconWifi } from "./icons";

interface NavItem {
  id: PageId;
  label: string;
  Icon: ComponentType<{ size?: number }>;
}

const NAV: NavItem[] = [
  { id: "instances", label: "实例", Icon: IconInstances },
  { id: "accounts", label: "账号", Icon: IconUser },
  { id: "download", label: "游戏", Icon: IconDownload },
  { id: "downloads", label: "管理", Icon: IconList },
  { id: "mods", label: "资源", Icon: IconMods },
  { id: "net", label: "联机", Icon: IconWifi },
  { id: "java", label: "Java", Icon: IconJava },
  { id: "personalize", label: "个性化", Icon: IconPalette },
  { id: "launch", label: "启动", Icon: IconRocket },
  { id: "other", label: "其它", Icon: IconSliders },
  { id: "about", label: "关于", Icon: IconInfo },
  { id: "settings", label: "设置", Icon: IconSettings },
];

export function Sidebar() {
  const { page, navigate, info, update } = useApp();
  const { runningCount } = useTasks();

  return (
    <aside className="sidebar">
      <nav className="nav" aria-label="主导航">
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
            <span>{item.label}</span>
            {item.id === "instances" && runningCount > 0 ? <span className="nav-dot" aria-hidden="true" /> : null}
            {item.id === "about" && update?.hasUpdate ? (
              <span className="nav-badge" data-nav-update title={`有新版本 v${update.latest}`}>
                新
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        {isMockApi ? <span className="mock-badge">浏览器预览 · 假数据</span> : <span className="mock-badge live">已连接主进程</span>}
        <span className="version-line">
          {info ? `v${info.version}` : "v0.1.5"}
          {update?.hasUpdate ? (
            <button
              type="button"
              className="version-dot"
              data-version-dot
              title={`有新版本 v${update.latest}，点此查看`}
              aria-label={`有新版本 v${update.latest}，点此查看`}
              onClick={() => navigate("about")}
            />
          ) : null}
        </span>
      </div>
    </aside>
  );
}