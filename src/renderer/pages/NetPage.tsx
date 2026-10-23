import { useState, type ReactNode } from "react";
import { IconLink, IconWifi } from "../components/icons";
import { useT } from "../lib/i18n";
import { NetFrpTab } from "./NetFrpTab";
import { NetLanTab } from "./NetLanTab";

type NetTab = "lan" | "frp";

/** 联机页的两种方式：局域网直连与内置樱花穿透。 */
const TABS: Array<{ value: NetTab; titleKey: string; hintKey: string; icon: ReactNode }> = [
  {
    value: "lan",
    titleKey: "pages.net.lanTitle",
    hintKey: "pages.net.lanHint",
    icon: <IconWifi size={16} />,
  },
  {
    value: "frp",
    titleKey: "pages.net.frpTitle",
    hintKey: "pages.net.frpHint",
    icon: <IconLink size={16} />,
  },
];

/** 联机页：顶部两个 Tab 在「局域网」与「樱花穿透（内置）」之间切换。 */
export function NetPage() {
  const [tab, setTab] = useState<NetTab>("lan");
  const t = useT();

  return (
    <section className="page" data-net-tab={tab}>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("pages.net.title")}</h1>
          <p className="page-sub">
            {tab === "lan" ? t("pages.net.subLan") : t("pages.net.subFrp")}
          </p>
        </div>
      </header>

      <div className="net-tabs" role="tablist" aria-label={t("pages.net.tabsAria")}>
        {TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={tab === item.value}
            className={"net-tab " + (tab === item.value ? "active" : "")}
            data-net-tab-button={item.value}
            onClick={() => setTab(item.value)}
          >
            <span className="net-tab-title">
              {item.icon}
              {t(item.titleKey)}
            </span>
            <span className="net-tab-hint">{t(item.hintKey)}</span>
          </button>
        ))}
      </div>

      {tab === "lan" ? <NetLanTab /> : <NetFrpTab />}
    </section>
  );
}
