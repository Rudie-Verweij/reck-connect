import { iconLightbulb, iconMoon, iconRail, iconSettings } from "./icons";

export type Theme = "light" | "dark";

export interface AppBarProps {
  root: HTMLElement;
  onToggleRail: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
}

export class AppBar {
  private railBtn!: HTMLButtonElement;
  private themeBtn!: HTMLButtonElement;

  constructor(private props: AppBarProps) {
    this.props.root.innerHTML = `
      <div class="nav">
        <div class="nav-brand">Reck<span class="dot"></span></div>
        <div class="nav-subtitle">Satellite</div>
        <div class="nav-spacer"></div>
        <div class="nav-actions">
          <button class="icon-btn" id="nav-theme" title="Toggle theme">${iconLightbulb}</button>
          <button class="icon-btn" id="nav-rail" title="Toggle projects rail (⌘B · ⇧←/⇧→)">${iconRail}</button>
          <button class="icon-btn" id="nav-settings" title="Settings">${iconSettings}</button>
        </div>
      </div>
    `;
    this.railBtn = this.props.root.querySelector("#nav-rail") as HTMLButtonElement;
    this.themeBtn = this.props.root.querySelector("#nav-theme") as HTMLButtonElement;
    this.railBtn.addEventListener("click", () => this.props.onToggleRail());
    this.themeBtn.addEventListener("click", () => this.props.onToggleTheme());
    (this.props.root.querySelector("#nav-settings") as HTMLButtonElement).addEventListener(
      "click",
      () => this.props.onOpenSettings(),
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
