import { iconChart, iconLightbulb, iconMoon, iconRail } from "./icons";
import { WINDOW_HEADER_CLASS } from "./window-header";

export type Theme = "light" | "dark";

export interface AppBarProps {
  root: HTMLElement;
  onToggleRail: () => void;
  onToggleTheme: () => void;
  onOpenUsage: () => void;
}

export class AppBar {
  private railBtn!: HTMLButtonElement;
  private themeBtn!: HTMLButtonElement;

  constructor(private props: AppBarProps) {
    this.props.root.innerHTML = `
      <!-- Shared window title bar: the traffic-light inset, drag region and
           no-zoom rule come from WINDOW_HEADER_CLASS. The nav class adds only
           this window's own height, colours and spacing. -->
      <div class="${WINDOW_HEADER_CLASS} nav">
        <div class="nav-brand">Reck<span class="dot"></span></div>
        <div class="nav-subtitle">Satellite</div>
        <div class="nav-spacer"></div>
        <div class="nav-actions">
          <button class="icon-btn" id="nav-theme" title="Toggle theme">${iconLightbulb}</button>
          <button class="icon-btn" id="nav-usage" title="View usage">${iconChart}</button>
          <button class="icon-btn" id="nav-rail" title="Toggle projects rail (⌘B · ⇧←/⇧→)">${iconRail}</button>
        </div>
      </div>
    `;
    this.railBtn = this.props.root.querySelector("#nav-rail") as HTMLButtonElement;
    this.themeBtn = this.props.root.querySelector("#nav-theme") as HTMLButtonElement;
    this.railBtn.addEventListener("click", () => this.props.onToggleRail());
    this.themeBtn.addEventListener("click", () => this.props.onToggleTheme());
    (this.props.root.querySelector("#nav-usage") as HTMLButtonElement).addEventListener(
      "click",
      () => this.props.onOpenUsage(),
    );
  }

  /** Rail-toggle button state: active while the rail is expanded, inactive in mini. */
  setRailExpanded(expanded: boolean) {
    this.railBtn.classList.toggle("active", expanded);
  }

  setTheme(theme: Theme) {
    this.themeBtn.innerHTML = theme === "dark" ? iconMoon : iconLightbulb;
    this.themeBtn.title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  }
}
