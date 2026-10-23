import { perfMark } from "./lib/perf";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./css/controls.css";
import "./css/badges.css";
import "./css/overlays.css";
import "./css/pages.css";
import "./css/detail.css";
import "./css/mods.css";
import "./css/net.css";
import "./css/settings.css";
import "./css/personalize.css";
import "./css/settings-pages.css";
import "./css/accounts.css";
import "./css/about.css";
import "./css/downloads.css";
import "./css/skins.css";
import "./css/servers.css";

perfMark("renderer-module-loaded");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);