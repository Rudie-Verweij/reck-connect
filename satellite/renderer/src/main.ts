import "@xterm/xterm/css/xterm.css";
import { attachStartupSplash } from "./ui/startup-splash";

const splash = attachStartupSplash();

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="app-shell">
    <div class="app-main">
      <div class="rail">
        <div class="rail-header">PROJECTS</div>
        <div id="rail-list"></div>
      </div>
      <div class="pane-layout" id="pane-layout"></div>
    </div>
    <div class="status-bar" id="status-bar">Loading…</div>
  </div>
`;

import("./boot")
  .then((m) => m.boot(splash))
  .catch((e) => {
    const bar = document.getElementById("status-bar")!;
    bar.textContent = "Boot error: " + (e?.message ?? String(e));
    void splash.dismiss();
  });
