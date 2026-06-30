import { iconRefresh } from "./icons";

export interface StatusBarProps {
  root: HTMLElement;
  onRefresh?: () => Promise<void>;
}

export type ConnState = "connecting" | "connected" | "reconnecting";
export type MountState = "green" | "yellow" | "gray";
export type RefreshState = "idle" | "refreshing" | "error";

export interface StatusInfo {
  projectName: string;
  paneCount: number;
  projectCount: number;
  host: string;
  conn: ConnState;
  /** Optional reason for the last probe failure; shown in the CONN tooltip. */
  connError?: string | null;
  mount: MountState;
  /**
   * Concise, human reason for a degraded connection, shown INLINE next to
   * the CONN label (e.g. "RECONNECTING — station offline on Tailscale").
   * null when connected / nothing to explain.
   */
  connDetail?: string | null;
  /**
   * Hybrid mode rev 3.1, phase 9: when the station→local project-list
   * push fails, boot surfaces a one-line message here. The status bar
   * renders it as a small warning badge after the host label. Phase 11
   * will broaden the status bar to surface both hosts properly; this is
   * the deliberately-small hook that makes the failure visible in the
   * meantime rather than swallowed into the console.
   */
  localPushError?: string | null;
}

export class StatusBar {
  private messageEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private refreshBtn!: HTMLButtonElement;
  private mountDot!: HTMLElement;
  private connDot!: HTMLElement;
  private connLabel!: HTMLElement;
  private hostLabel!: HTMLElement;
  private localPushWarnEl!: HTMLElement;
  private refreshState: RefreshState = "idle";
  private refreshMessage: string | null = null;
  private errorClearTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private props: StatusBarProps) {
    this.props.root.classList.add("status-bar");
    this.props.root.innerHTML = `
      <span class="status-message" style="display:none;"></span>
      <span class="status-spacer"></span>
      <span class="status-right" style="display:none;">
        <button class="status-refresh-btn" type="button" title="Refresh connection & mount">${iconRefresh}</button>
        <span class="sep" style="opacity:0.3;margin:0 0.5rem;">·</span>
        <span class="dot mount-dot" style="margin-right:6px;"></span>MOUNT
        <span class="sep" style="opacity:0.3;margin:0 0.5rem;">·</span>
        <span class="dot conn-dot" style="margin-right:6px;"></span><span class="conn-label"></span>
        <span class="sep" style="opacity:0.3;margin:0 0.5rem;">·</span>
        <span class="host-label"></span>
        <span class="local-push-warn" style="display:none;margin-left:0.5rem;color:var(--wes-mustard,#c8a548);"></span>
      </span>
    `;
    this.messageEl = this.props.root.querySelector(".status-message") as HTMLElement;
    this.rightEl = this.props.root.querySelector(".status-right") as HTMLElement;
    this.refreshBtn = this.props.root.querySelector(".status-refresh-btn") as HTMLButtonElement;
    this.mountDot = this.props.root.querySelector(".mount-dot") as HTMLElement;
    this.connDot = this.props.root.querySelector(".conn-dot") as HTMLElement;
    this.connLabel = this.props.root.querySelector(".conn-label") as HTMLElement;
    this.hostLabel = this.props.root.querySelector(".host-label") as HTMLElement;
    this.localPushWarnEl = this.props.root.querySelector(".local-push-warn") as HTMLElement;

    if (this.props.onRefresh) {
      this.refreshBtn.addEventListener("click", () => void this.handleRefreshClick());
    } else {
      this.refreshBtn.style.display = "none";
    }
  }

  setInfo(info: StatusInfo) {
    this.messageEl.style.display = "none";
    this.rightEl.style.display = "";
    this.mountDot.style.background = this.mountColor(info.mount);
    this.mountDot.title = this.mountTitle(info.mount);
    this.connDot.style.background = this.connColor(info.conn);
    this.connDot.title = this.connTitle(info.conn, info.connError ?? null);
    // Surface the reason inline (not just in the dot tooltip) so a degraded
    // connection is legible at a glance in the existing status row.
    const detail = info.conn !== "connected" ? (info.connDetail ?? null) : null;
    this.connLabel.textContent = detail
      ? `${info.conn.toUpperCase()} — ${detail}`
      : info.conn.toUpperCase();
    this.hostLabel.textContent = info.host;
    const pushErr = info.localPushError ?? null;
    if (pushErr) {
      this.localPushWarnEl.style.display = "";
      this.localPushWarnEl.textContent = "· LOCAL ⚠";
      this.localPushWarnEl.title = pushErr;
    } else {
      this.localPushWarnEl.style.display = "none";
      this.localPushWarnEl.textContent = "";
      this.localPushWarnEl.title = "";
    }
  }

  setMessage(msg: string) {
    this.rightEl.style.display = "none";
    this.messageEl.style.display = "";
    this.messageEl.textContent = msg;
  }

  /**
   * Update the refresh-button affordance. `message` is surfaced in the
   * tooltip so the user can distinguish timeouts from HTTP errors or
   * mount kickstart failures. Pass null to clear it.
   */
  setRefreshState(state: RefreshState, message: string | null = null) {
    this.refreshState = state;
    this.refreshMessage = message;
    this.refreshBtn.classList.toggle("refreshing", state === "refreshing");
    this.refreshBtn.classList.toggle("error", state === "error");
    this.refreshBtn.disabled = state === "refreshing";
    if (state === "refreshing") {
      this.refreshBtn.title = "Refreshing…";
    } else if (state === "error") {
      this.refreshBtn.title = message
        ? `Refresh failed — ${message}. Click to retry`
        : "Refresh failed — click to retry";
    } else {
      this.refreshBtn.title = "Refresh connection & mount";
    }
  }

  private async handleRefreshClick() {
    if (!this.props.onRefresh) return;
    if (this.refreshState === "refreshing") return;
    if (this.errorClearTimer) {
      clearTimeout(this.errorClearTimer);
      this.errorClearTimer = null;
    }
    this.setRefreshState("refreshing");
    try {
      await this.props.onRefresh();
      this.setRefreshState("idle");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("status refresh failed", e);
      this.setRefreshState("error", message);
      this.errorClearTimer = setTimeout(() => {
        if (this.refreshState === "error") this.setRefreshState("idle");
        this.errorClearTimer = null;
      }, 4000);
    }
  }

  private connColor(c: ConnState): string {
    switch (c) {
      case "connected": return "var(--wes-sage)";
      case "reconnecting": return "var(--wes-mustard)";
      default: return "var(--claude-mid)";
    }
  }

  private connTitle(c: ConnState, error: string | null): string {
    switch (c) {
      case "connected": return "Connected";
      case "reconnecting": return error ? `Reconnecting — ${error}` : "Reconnecting";
      default: return "Connecting…";
    }
  }

  private mountColor(m: MountState): string {
    switch (m) {
      case "green": return "var(--wes-sage)";
      case "yellow": return "var(--wes-mustard)";
      default: return "var(--claude-mid)";
    }
  }

  private mountTitle(m: MountState): string {
    const manual =
      "\nManual restart: launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-mount";
    switch (m) {
      case "green": return "Mount healthy";
      case "yellow": return `Mount not responding — reconnecting${manual}`;
      default: return `Mount not configured${manual}`;
    }
  }
}
