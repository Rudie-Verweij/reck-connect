import { iconChart, iconLightbulb, iconMoon, iconRail } from "./icons";
import { planLabel } from "./usage-plan";

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
  private planEl!: HTMLElement;

  constructor(private props: AppBarProps) {
    this.props.root.innerHTML = `
      <div class="nav">
        <div class="nav-brand">Reck<span class="dot"></span></div>
        <div class="nav-subtitle">Satellite</div>
        <div class="nav-spacer"></div>
        <div class="nav-actions">
          <span class="nav-plan" id="nav-plan" hidden></span>
          <button class="icon-btn" id="nav-theme" title="Toggle theme">${iconLightbulb}</button>
          <button class="icon-btn" id="nav-usage" title="View usage">${iconChart}</button>
          <button class="icon-btn" id="nav-rail" title="Toggle projects rail (⌘B · ⇧←/⇧→)">${iconRail}</button>
        </div>
      </div>
    `;
    this.railBtn = this.props.root.querySelector("#nav-rail") as HTMLButtonElement;
    this.themeBtn = this.props.root.querySelector("#nav-theme") as HTMLButtonElement;
    this.planEl = this.props.root.querySelector("#nav-plan") as HTMLElement;
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

  /**
   * Current subscription tier, shown next to the usage button. This is
   * the tier right now — the day-by-day composition of a period lives in
   * the usage view, which is the only place a range exists. Pass
   * undefined to hide the badge (station without usage tracking, or no
   * plan observed yet).
   */
  setPlan(subscription: string | undefined) {
    const label = planLabel(subscription);
    this.planEl.textContent = label;
    this.planEl.hidden = label === "";
    this.planEl.title = label === "" ? "" : `Claude subscription: ${label}`;
  }
}
