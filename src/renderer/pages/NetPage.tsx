import { useState, type ReactNode } from "react";
import { IconLink, IconWifi } from "../components/icons";
import { NetFrpTab } from "./NetFrpTab";
import { NetLanTab } from "./NetLanTab";

type NetTab = "lan" | "frp";

/** 联机页的两种方式：局域网直连与内置樱花穿透。 */
const TABS: Array<{ value: NetTab; title: string; hint: string; icon: ReactNode }> = [
  { value: "lan", title: "局域网", hint: "同一 Wi-Fi / 有线网络内直连", icon: <IconWifi size={16} /> },
  { value: "frp", title: "樱花穿透（内置）", hint: "映射到公网，好友凭地址直连", icon: <IconLink size={16} /> },
];

/** 联机页：顶部两个 Tab 在「局域网」与「樱花穿透（内置）」之间切换。 */
export function NetPage() {
  const [tab, setTab] = useState<NetTab>("lan");

  return (
    <section className="page" data-net-tab={tab}>
      <header className="page-head">
        <div>
          <h1 className="page-title">联机</h1>
          <p className="page-sub">
            {tab === "lan"
              ? "把本机地址发给同一局域网的好友，好友在游戏里填地址就能进你的房间"
              : "用内置樱花穿透把本地房间映射到公网，好友凭公网地址直连"}
          </p>
        </div>
      </header>

      <div className="net-tabs" role="tablist" aria-label="联机方式">
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
              {item.title}
            </span>
            <span className="net-tab-hint">{item.hint}</span>
          </button>
        ))}
      </div>

      {tab === "lan" ? <NetLanTab /> : <NetFrpTab />}
    </section>
  );
}
