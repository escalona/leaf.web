import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { configure } from "mobx";
import { AppBoot } from "./AppBoot";
import { markStartup } from "../core/lib/startup-marks";
import "../core/fonts/inter.css";
import "./global.css";

markStartup("renderer-boot");

// Enable MobX strict mode — all mutations must be in actions
configure({ enforceActions: "observed" });

const root = createRoot(document.getElementById("root")!);

root.render(
  <StrictMode>
    <AppBoot />
  </StrictMode>,
);
