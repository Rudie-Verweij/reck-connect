import type {
  MCStateMessage,
  MissionControlCard,
  MissionControlPane,
  MissionControlStateResponse,
  Stoplight,
} from "@proto/proto";
import { stoplightSeverity } from "@proto/proto";
import type { ApiClient } from "@client-core/api/client";
import { TerminalPane, type PaneTheme } from "@client-core/terminal/terminal-pane";
import type { HostRef } from "../host";

/**
 * Per-host ApiClients, at least one of which must be provided.
 *
 * Phase 11 (hybrid mode rev 3.1): MissionControl previously took a
 * single `client` and resolved everything against it; in hybrid mode it
 * needs to merge MC feeds from both daemons so a card for project X
 * surfaces panes running on both hosts side-by-side. Supervisor-chat /
 * -reset / -TerminalPane stay on the primary (station when enabled),
 * because the supervisor is a Claude pane spawned on the station and
 * its lifecycle is meaningless against a station-disabled daemon.
 */
export type MissionControlClients = Partial<Record<HostRef, ApiClient>>;

export interface MissionControlProps {
  root: HTMLElement;
  /** One or both host ApiClients. Throws at construction if neither set. */
  clients: MissionControlClients;
  theme: PaneTheme;
  onOpenProject: (projectId: string) => void;
  /**
   * Optional. Triggered by the Undock button on each MC card. boot.ts
   * wires this to `client.undockProject(projectId)` against the host
   * the project is registered with (cards know their host via the
   * primary feed). When omitted the Undock button is hidden — useful
   * for tests / non-hybrid setups.
   */
  onUndockProject?: (projectId: string) => void;
  onAggregateChange?: (stoplight: Stoplight) => void;
}

/**
 * Card with each pane annotated by the host it runs on. Phase 11 uses
 * this internally so `renderCard` can draw a per-pane host badge
 * without plumbing an out-of-band map through every render call. The
 * wire type `MissionControlPane` stays untouched — the host annotation
 * is renderer-only.
 */
type HostTaggedPane = MissionControlPane & { _host: HostRef };
type HostTaggedCard = Omit<MissionControlCard, "panes"> & { panes: HostTaggedPane[] };

/**
 * Mission Control view. Renders a cards grid for every docked project
 * and hosts the supervisor — a dedicated Claude Code pane on the station
 * side, surfaced here through the same terminal widget used elsewhere.
 *
 * Lifecycle is controlled by boot.ts: show() when the MC rail item is
 * selected, hide() on any other selection, dispose() on app teardown.
 * The MC WebSocket is only held open while visible.
 */
export class MissionControl {
  public readonly container: HTMLElement;
  private cardsHost: HTMLElement;
  private statusEl: HTMLElement;
  private supervisorHost: HTMLElement;
  private startButton: HTMLButtonElement;
  private resetButton: HTMLButtonElement;
  private trafficLightEl: HTMLElement;
  // Per-host WS channels. Single-host setups populate just one entry.
  private wss = new Map<HostRef, WebSocket>();
  // Reconnect timers per host. Post-codex fixup round 2: dropping
  // the socket + clearing cached state on `onclose` killed stale
  // cards, but without a reconnect a transient blip turned a host
  // into "blank forever" until the user left MC and came back. The
  // timer schedules a re-open attempt; it's cleared on hide/dispose
  // and re-used across attempts for a single host (so only one
  // pending reconnect per host at a time).
  private reconnectTimers = new Map<HostRef, ReturnType<typeof setTimeout>>();
  // Attempt counter per host — feeds a gentle exponential backoff
  // so a permanently-dead host doesn't spam the console. Reset to 0
  // on a successful `onopen`.
  private reconnectAttempts = new Map<HostRef, number>();
  // Per-host state snapshots; the rendered view is the merge of all
  // present entries, keyed by project_id.
  private statesByHost = new Map<HostRef, MissionControlStateResponse>();
  // The primary-host client drives supervisor operations (start / reset
  // / chat / TerminalPane). Station if enabled, else local — matches
  // the `derivedMode` convention used elsewhere in boot.
  // The primary host drives the cards-merge ordering + supervisor
  // gating. Unlike the rest of the app, MC's "primary" is ONLY
  // meaningful when station is enabled — a station-disabled deployment has
  // no supervisor to talk to, so supervisor controls hide entirely in
  // that shape (see `supervisorAvailable`).
  private primaryHost: HostRef;
  // Supervisor operations (start / reset / chat / TerminalPane) are
  // station-only by design (plan rev 3.1, phase 11 scope). This field
  // is null when station isn't enabled; callers that route through it
  // must already have checked `supervisorAvailable`.
  private supervisorClient: ApiClient | null;
  private supervisorAvailable: boolean;
  private supervisorPane: TerminalPane | null = null;
  private supervisorPaneID: string | null = null;
  private theme: PaneTheme;
  private visible = false;
  private lastAggregate: Stoplight = "gray";
  private clickCooldown = new Map<string, number>();
  private clickInflight = new Set<string>();

  constructor(private props: MissionControlProps) {
    // Phase 11 invariant: at least one host client must be provided.
    // Keeps the surface area honest — a MissionControl with no clients
    // can't surface anything and would silently render an empty rail.
    const hasStation = !!props.clients.station;
    const hasLocal = !!props.clients.local;
    if (!hasStation && !hasLocal) {
      throw new Error("MissionControl requires at least one of clients.station / clients.local");
    }
    this.primaryHost = hasStation ? "station" : "local";
    this.supervisorClient = hasStation ? (props.clients.station as ApiClient) : null;
    this.supervisorAvailable = hasStation;
    this.theme = props.theme;
    this.container = document.createElement("div");
    this.container.className = "mission-control";
    this.container.innerHTML = `
      <header class="mc-header">
        <div class="mc-title">
          <h1>Mission Control</h1>
        </div>
        <div class="mc-status" id="mc-status">Connecting…</div>
        <span class="dot gray" id="mc-traffic-light" title="Docked-project health (aggregate). Gray when supervisor is offline." aria-label="Docked-project health"></span>
        <div class="mc-actions">
          <button type="button" class="mc-btn" id="mc-start">Start supervisor</button>
          <button type="button" class="mc-btn mc-btn-ghost" id="mc-reset" disabled>Reset</button>
        </div>
      </header>
      <section class="mc-cards" id="mc-cards">
        <div class="mc-empty">No projects docked yet. Right-click a project in the rail → <em>Dock in Mission Control</em> to add it here.</div>
      </section>
      <section class="mc-supervisor">
        <div class="mc-supervisor-header">Supervisor</div>
        <div class="mc-supervisor-host" id="mc-supervisor-host">
          <div class="mc-supervisor-idle">The supervisor isn't running yet. Click <strong>Start supervisor</strong> to spawn it.</div>
        </div>
      </section>
    `;
    this.cardsHost = this.container.querySelector("#mc-cards") as HTMLElement;
    this.statusEl = this.container.querySelector("#mc-status") as HTMLElement;
    this.supervisorHost = this.container.querySelector("#mc-supervisor-host") as HTMLElement;
    this.startButton = this.container.querySelector("#mc-start") as HTMLButtonElement;
    this.resetButton = this.container.querySelector("#mc-reset") as HTMLButtonElement;
    this.trafficLightEl = this.container.querySelector("#mc-traffic-light") as HTMLElement;

    this.startButton.addEventListener("click", () => void this.handleStartSupervisor());
    this.resetButton.addEventListener("click", () => void this.handleResetSupervisor());

    // Phase 10/11 fixup (post-codex): when station isn't enabled the
    // supervisor has no daemon to live on — hide the controls and
    // replace the idle-state message rather than silently routing
    // chat/reset/terminal through a local daemon that has no
    // supervisor concept. Cards + merging still work for station-disabled
    // MC, they just don't get a supervisor pane below them.
    if (!this.supervisorAvailable) {
      const actions = this.container.querySelector<HTMLElement>(".mc-actions");
      if (actions) actions.style.display = "none";
      const supervisorSection = this.container.querySelector<HTMLElement>(
        ".mc-supervisor",
      );
      if (supervisorSection) {
        supervisorSection.innerHTML = `
          <div class="mc-supervisor-header">Supervisor</div>
          <div class="mc-supervisor-host" id="mc-supervisor-host">
            <div class="mc-supervisor-idle">
              The supervisor is a station-only feature. Enable the
              station in Preferences to use it.
            </div>
          </div>
        `;
        this.supervisorHost = supervisorSection.querySelector(
          "#mc-supervisor-host",
        ) as HTMLElement;
      }
    }
  }

  /**
   * Return the supervisor ApiClient or throw if supervisor isn't
   * available. Used by the station-only code paths (start / reset /
   * chat / TerminalPane). Throwing is deliberate: the UI surfaces
   * that drive these methods are hidden when `supervisorAvailable`
   * is false, so reaching this helper implies a programmer error
   * (renderer wired a click handler that should have been skipped).
   */
  private requireSupervisorClient(): ApiClient {
    if (!this.supervisorClient) {
      throw new Error(
        "supervisor operation attempted with station disabled — " +
          "UI should have hidden the control",
      );
    }
    return this.supervisorClient;
  }

  /**
   * Aggregate traffic-light across the merged card view. Returns gray
   * when the primary supervisor is offline — the supervisor's own
   * availability gates the worst-case reading, matching the pre-Phase-
   * 11 semantics ("green unless the supervisor says otherwise"). A
   * station-disabled deployment has no supervisor, so its aggregate is
   * always gray today; that's consistent with the rev 3.1 scope note
   * that supervisor remains station-only.
   */
  private computeAggregate(cards: HostTaggedCard[]): Stoplight {
    const primaryState = this.statesByHost.get(this.primaryHost);
    if (!primaryState?.supervisor_online) return "gray";
    let best: Stoplight = "gray";
    for (const c of cards) {
      if (stoplightSeverity(c.stoplight) > stoplightSeverity(best)) {
        best = c.stoplight;
      }
    }
    return best;
  }

  /**
   * Merge the current per-host state snapshots into a single
   * card list for rendering. Cards from different hosts that share a
   * `project_id` are combined (panes concatenated with host tags); a
   * project present on only one host surfaces just once.
   *
   * Ordering: the primary host's cards drive order. Cards from the
   * secondary host that aren't on the primary are appended in their
   * original order — deterministic without the caller having to sort.
   */
  private mergeCards(): HostTaggedCard[] {
    const out: HostTaggedCard[] = [];
    const byId = new Map<string, HostTaggedCard>();
    const secondaryHost: HostRef = this.primaryHost === "station" ? "local" : "station";
    const ordered: HostRef[] = [this.primaryHost, secondaryHost];
    for (const host of ordered) {
      const state = this.statesByHost.get(host);
      if (!state) continue;
      for (const c of state.cards) {
        const existing = byId.get(c.project_id);
        const taggedPanes: HostTaggedPane[] = c.panes.map((p) => ({ ...p, _host: host }));
        if (existing) {
          existing.panes = existing.panes.concat(taggedPanes);
          existing.pane_count = existing.panes.length;
          if (stoplightSeverity(c.stoplight) > stoplightSeverity(existing.stoplight)) {
            existing.stoplight = c.stoplight;
          }
          continue;
        }
        const merged: HostTaggedCard = {
          project_id: c.project_id,
          project_name: c.project_name,
          cwd: c.cwd,
          stoplight: c.stoplight,
          pane_count: taggedPanes.length,
          panes: taggedPanes,
        };
        byId.set(c.project_id, merged);
        out.push(merged);
      }
    }
    return out;
  }

  private updateTrafficLight(aggregate: Stoplight) {
    this.trafficLightEl.className = `dot ${aggregate}`;
    if (aggregate !== this.lastAggregate) {
      this.lastAggregate = aggregate;
      this.props.onAggregateChange?.(aggregate);
    }
  }

  setTheme(theme: PaneTheme) {
    this.theme = theme;
    // TerminalPane doesn't expose a theme setter today — a restart
    // picks up the new theme. Cheap; supervisor is not on the critical
    // path for theme switches.
  }

  async show() {
    if (this.visible) return;
    this.visible = true;
    this.props.root.appendChild(this.container);
    // Fetch an initial snapshot from every enabled host in parallel so
    // the first paint after show() is not waiting on the WS upgrade.
    // Failures are tolerated per-host: a station outage shouldn't blank
    // the local-side card list, and vice versa.
    const hosts = this.enabledHosts();
    await Promise.all(
      hosts.map(async (host) => {
        const client = this.props.clients[host];
        if (!client) return;
        try {
          const snap = await client.missionControlState();
          this.statesByHost.set(host, snap);
        } catch (e) {
          console.error(`MC initial state fetch failed for ${host}`, e);
        }
      }),
    );
    this.applyMergedState();
    if (this.statesByHost.size === 0) {
      this.statusEl.textContent = "Offline";
    }
    for (const host of hosts) this.openWebSocket(host);
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    // Kill any pending reconnects first — otherwise a timer that
    // was about to fire would open a fresh WS just as we tear down.
    this.clearAllReconnectTimers();
    this.closeAllWebSockets();
    // Supervisor pane stays running on the station when we hide — the
    // user may return. We only tear it down on explicit Reset.
    if (this.supervisorPane) {
      this.supervisorPane.dispose?.();
      this.supervisorPane = null;
    }
    this.container.remove();
    this.supervisorHost.innerHTML = `<div class="mc-supervisor-idle">Supervisor running on the station — switch back to Mission Control to interact.</div>`;
  }

  dispose() {
    // Always tear down WS + reconnect timers + supervisor-pane state
    // regardless of visibility. `hide()` early-returns when not
    // visible (fine for user-initiated tab-switches); dispose is
    // the app-teardown path where everything must go, including any
    // WS opened out-of-band and any pending reconnect.
    this.hide();
    this.clearAllReconnectTimers();
    this.closeAllWebSockets();
    if (this.supervisorPane) {
      this.supervisorPane.dispose?.();
      this.supervisorPane = null;
    }
  }

  private enabledHosts(): HostRef[] {
    const out: HostRef[] = [];
    if (this.props.clients.station) out.push("station");
    if (this.props.clients.local) out.push("local");
    return out;
  }

  private openWebSocket(host: HostRef) {
    this.closeWebSocket(host);
    const client = this.props.clients[host];
    if (!client) return;
    const url = client.missionControlWsUrl();
    const protocols = client.wsSubprotocols();
    let ws: WebSocket;
    try {
      // Browser-standard WS auth: the bearer rides as a
      // Sec-WebSocket-Protocol subprotocol. See ApiClient.wsSubprotocols.
      // An empty `protocols` array is equivalent to the single-arg
      // constructor form (used for unauthenticated local daemons).
      ws =
        protocols.length > 0
          ? new WebSocket(url, protocols)
          : new WebSocket(url);
    } catch (e) {
      console.error(`MC WS open failed for ${host}`, e);
      return;
    }
    this.wss.set(host, ws);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as MCStateMessage;
        if (msg.type === "state") {
          this.statesByHost.set(host, msg.state);
          this.applyMergedState();
        }
      } catch (e) {
        console.warn(`MC WS parse failed for ${host}`, e);
      }
    };
    ws.onopen = () => {
      // Successful reconnect — clear the backoff counter so the
      // next outage starts from a short delay.
      this.reconnectAttempts.set(host, 0);
      // Don't re-fetch state here. The daemon's ServeWS sends an
      // initial MCStateMessage on connect (see
      // daemon/internal/supervisor/http.go ~L184), so the WS's
      // first `onmessage` will seed statesByHost. Fetching a
      // separate HTTP snapshot would race: if the socket closes
      // between `onopen` and the fetch resolving, `onclose` drops
      // the cached state, then the late fetch writes it back — the
      // stale-state bug we just fixed.
      this.refreshStatusLine();
    };
    ws.onclose = () => {
      this.wss.delete(host);
      // Post-codex fixup (round 1): treat WS close as loss of
      // authority for this host. Drop its cached state so its last
      // snapshot stops contributing stale cards / panes to the
      // merged view.
      if (this.statesByHost.has(host)) {
        this.statesByHost.delete(host);
        this.applyMergedState();
      }
      this.refreshStatusLine();
      // Post-codex fixup (round 2): schedule a reconnect while MC
      // is still visible. Without this a transient network blip
      // would blank the host indefinitely — `openWebSocket()` was
      // only called from `show()`. The reconnect is throttled with
      // a gentle exponential backoff (1.5, 3, 6, 12, 30 s cap) so
      // a permanently-dead host doesn't burn CPU/logs.
      if (this.visible) this.scheduleReconnect(host);
    };
    ws.onerror = () => {
      this.refreshStatusLine();
    };
  }

  /**
   * Schedule a reconnect for `host` with exponential-ish backoff.
   * Idempotent: a second call while a timer is already pending is
   * a no-op. Reset on successful `onopen`.
   */
  private scheduleReconnect(host: HostRef): void {
    if (this.reconnectTimers.has(host)) return;
    const attempt = (this.reconnectAttempts.get(host) ?? 0) + 1;
    this.reconnectAttempts.set(host, attempt);
    // 1.5, 3, 6, 12, 30 s cap.
    const delayMs = Math.min(30000, Math.round(1500 * Math.pow(2, attempt - 1)));
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(host);
      if (!this.visible) return;
      // Only reconnect hosts that are still enabled in our clients map.
      if (!this.props.clients[host]) return;
      this.openWebSocket(host);
    }, delayMs);
    this.reconnectTimers.set(host, timer);
  }

  private clearAllReconnectTimers(): void {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
  }

  private closeWebSocket(host: HostRef) {
    const ws = this.wss.get(host);
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
      this.wss.delete(host);
    }
  }

  private closeAllWebSockets() {
    for (const host of [...this.wss.keys()]) this.closeWebSocket(host);
  }

  /**
   * Summarise connection health across hosts in a single status line.
   * Keeps the pre-Phase-11 single-dot UX — operators watching the
   * status bar see "Live" when both hosts are happy, a per-host
   * callout when one side's WS is down. Only the primary host's
   * outage disables the supervisor controls (those live on the primary).
   */
  private refreshStatusLine() {
    const hosts = this.enabledHosts();
    if (hosts.length === 0) return;
    const connectedHosts = hosts.filter(
      (h) => this.wss.get(h)?.readyState === WebSocket.OPEN,
    );
    if (connectedHosts.length === hosts.length) {
      this.statusEl.textContent = "Live";
      this.statusEl.classList.add("ok");
      return;
    }
    this.statusEl.classList.remove("ok");
    if (connectedHosts.length === 0) {
      this.statusEl.textContent = "Disconnected";
      return;
    }
    const down = hosts.filter((h) => !connectedHosts.includes(h)).join(", ");
    this.statusEl.textContent = `Partial — ${down} disconnected`;
  }

  /**
   * Recompute the merged view from `statesByHost` and repaint. Called
   * after every per-host state update (initial fetch, WS message).
   * Supervisor lifecycle controls track the PRIMARY host's
   * `supervisor_online` — a local-daemon-only "supervisor" doesn't
   * exist in the rev 3.1 scope, so local feeds only contribute cards.
   */
  private applyMergedState() {
    const mergedCards = this.mergeCards();
    this.renderCards(mergedCards);
    this.updateTrafficLight(this.computeAggregate(mergedCards));
    // Supervisor controls track *station* only. If station isn't
    // enabled for this MC, the buttons were hidden at construction;
    // skip the enable/disable + ensure/teardown dance entirely so we
    // don't race a null supervisorClient into ensureSupervisorPane.
    if (!this.supervisorAvailable) return;
    const stationState = this.statesByHost.get("station");
    const supervisorOnline = !!stationState?.supervisor_online;
    this.startButton.disabled = supervisorOnline;
    this.resetButton.disabled = !supervisorOnline;
    this.startButton.textContent = supervisorOnline ? "Supervisor running" : "Start supervisor";
    if (supervisorOnline) {
      void this.ensureSupervisorPane();
    } else {
      this.teardownSupervisorPane();
    }
  }

  private renderCards(cards: HostTaggedCard[]) {
    if (cards.length === 0) {
      this.cardsHost.innerHTML = `<div class="mc-empty">No projects docked yet. Right-click a project in the rail → <em>Dock in Mission Control</em> to add it here.</div>`;
      return;
    }
    // Render by diffing vs. existing dom would be nicer; for v1, a full
    // re-render is fine — card counts stay small and updates are
    // throttled to manager state-change events, not keystrokes.
    this.cardsHost.innerHTML = "";
    for (const c of cards) {
      this.cardsHost.appendChild(this.renderCard(c));
    }
  }

  private renderCard(c: HostTaggedCard): HTMLElement {
    const card = document.createElement("div");
    card.className = `mc-card mc-card-${c.stoplight}`;
    card.tabIndex = 0;
    card.dataset.projectId = c.project_id;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Ask supervisor about ${c.project_name}`);
    card.innerHTML = `
      <div class="mc-card-head">
        <span class="mc-card-name">${escapeHtml(c.project_name)}</span>
        <span class="dot ${c.stoplight}"></span>
      </div>
      <div class="mc-card-cwd" title="${escapeHtml(c.cwd)}">${escapeHtml(truncatePath(c.cwd))}</div>
      <ul class="mc-card-panes">${c.panes.map(renderPaneLine).join("") || `<li class="empty">no panes</li>`}</ul>
      <div class="mc-card-foot">
        <span class="mc-card-count">${c.pane_count} pane${c.pane_count === 1 ? "" : "s"}</span>
        <span class="mc-card-actions">
          ${this.props.onUndockProject ? `<button type="button" class="mc-card-undock" data-project-id="${escapeAttr(c.project_id)}" title="Remove from Mission Control (project keeps running)">Undock</button>` : ""}
          <button type="button" class="mc-card-open" data-project-id="${escapeAttr(c.project_id)}">Open →</button>
        </span>
      </div>
    `;
    const openBtn = card.querySelector(".mc-card-open") as HTMLButtonElement;
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.props.onOpenProject(c.project_id);
    });
    const undockBtn = card.querySelector(".mc-card-undock") as HTMLButtonElement | null;
    if (undockBtn && this.props.onUndockProject) {
      undockBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.props.onUndockProject!(c.project_id);
      });
    }
    card.addEventListener("click", (e) => {
      // Native dblclick fires click first — e.detail > 1 means this click
      // is part of a double-click to open. Bail so we don't send a chat
      // ping on the way to opening the project.
      if (e.detail > 1) return;
      const tgt = e.target as HTMLElement;
      if (tgt.closest(".mc-card-open") || tgt.closest(".mc-card-undock")) return;
      void this.askAboutCard(card, c);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        // Don't hijack native keyboard activation on the action buttons —
        // Space/Enter on Undock or Open should fire their own click,
        // not the card-level supervisor ping.
        const focus = document.activeElement as HTMLElement | null;
        if (
          focus &&
          (focus.classList.contains("mc-card-open") ||
            focus.classList.contains("mc-card-undock"))
        ) {
          return;
        }
        e.preventDefault();
        void this.askAboutCard(card, c);
      }
    });
    card.addEventListener("dblclick", (e) => {
      // A dblclick that ends on an action button is the user double-tapping
      // that button — don't also navigate into the project.
      const tgt = e.target as HTMLElement;
      if (tgt.closest(".mc-card-open") || tgt.closest(".mc-card-undock")) return;
      e.preventDefault();
      this.props.onOpenProject(c.project_id);
    });
    return card;
  }

  private async askAboutCard(card: HTMLElement, c: HostTaggedCard) {
    if (this.clickInflight.has(c.project_id)) return;
    const now = Date.now();
    const last = this.clickCooldown.get(c.project_id) ?? 0;
    if (now - last < 500) return;

    // Supervisor must be running on the station — otherwise chat
    // would silently try to spawn it on the wrong daemon (local has
    // no supervisor). Flash a red "ask-failed" to steer the user to
    // Start supervisor (or to Preferences → Station if they haven't
    // enabled station at all).
    if (!this.supervisorAvailable) {
      card.classList.add("ask-failed");
      window.setTimeout(() => card.classList.remove("ask-failed"), 1200);
      return;
    }
    const stationState = this.statesByHost.get("station");
    if (!stationState?.supervisor_online) {
      card.classList.add("ask-failed");
      window.setTimeout(() => card.classList.remove("ask-failed"), 1200);
      return;
    }

    this.clickCooldown.set(c.project_id, now);
    this.clickInflight.add(c.project_id);
    card.classList.add("asking");
    window.setTimeout(() => card.classList.remove("asking"), 900);

    const msg = `[focus ${c.project_id}] ${c.project_name} — status?`;
    try {
      await this.requireSupervisorClient().missionControlChat(msg);
    } catch (e) {
      console.error("mission-control card chat failed", e);
      card.classList.remove("asking");
      card.classList.add("ask-failed");
      window.setTimeout(() => card.classList.remove("ask-failed"), 1200);
    } finally {
      this.clickInflight.delete(c.project_id);
    }
  }

  private async handleStartSupervisor() {
    this.startButton.disabled = true;
    this.startButton.textContent = "Starting…";
    try {
      // ServeChat rejects empty messages, so use a non-empty priming
      // line that's harmless if the model sees it. The user's next
      // keystroke in the terminal will be the "real" first message.
      // Supervisor is station-only by design (plan rev 3.1 Phase 11);
      // always route through the primary client.
      await this.requireSupervisorClient().missionControlChat("Hi — I'm the user. What's the status across docked projects?");
    } catch (e) {
      console.error("start supervisor failed", e);
      this.startButton.disabled = false;
      this.startButton.textContent = "Start supervisor";
      this.statusEl.textContent = "Start failed: " + (e as Error).message;
    }
  }

  private async handleResetSupervisor() {
    if (!confirm("Reset wipes the supervisor conversation and spawns a fresh instance. Continue?")) return;
    try {
      await this.requireSupervisorClient().missionControlReset();
    } catch (e) {
      console.error("reset supervisor failed", e);
    }
  }

  private async ensureSupervisorPane() {
    if (this.supervisorPane) return;
    // Find the supervisor pane ID. The MC state doesn't include it
    // today, so we fetch it indirectly: the supervisor pane lives in
    // the hidden meta-project with the known ID. We query /projects/
    // with that ID to enumerate panes. Always on the primary (station)
    // client — the supervisor meta-project is never projected onto the
    // local daemon.
    try {
      const detail = await fetch(
        this.requireSupervisorClient().config.baseUrl + "/projects/__reck_supervisor__",
        { headers: this.authHeaders() },
      ).then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<{ panes: Array<{ id: string }> }>;
      });
      const pane = detail.panes[0];
      if (!pane) return;
      this.supervisorPaneID = pane.id;
      this.mountSupervisorTerminal(pane.id);
    } catch (e) {
      console.error("fetch supervisor pane id failed", e);
    }
  }

  private mountSupervisorTerminal(paneID: string) {
    this.supervisorHost.innerHTML = "";
    const wsUrl = this.requireSupervisorClient().wsUrl("__reck_supervisor__", paneID);
    this.supervisorPane = new TerminalPane({
      wsUrl,
      // Thunk so a mid-session token rotation reaches the next
      // reconnect attempt — see PaneLayout / PaneWS for the same
      // pattern. Without it, a 1008 close on this supervisor pane
      // would replay the stale token forever.
      wsSubprotocols: () => this.requireSupervisorClient().wsSubprotocols(),
      theme: this.theme,
      onExit: () => {
        // Pane exit → clear so the next state update triggers teardown.
        this.teardownSupervisorPane();
      },
    });
    this.supervisorHost.appendChild(this.supervisorPane.container);
    this.supervisorPane.mount();
  }

  private teardownSupervisorPane() {
    if (this.supervisorPane) {
      this.supervisorPane.dispose?.();
      this.supervisorPane = null;
    }
    this.supervisorPaneID = null;
    this.supervisorHost.innerHTML = `<div class="mc-supervisor-idle">The supervisor isn't running. Click <strong>Start supervisor</strong> to spawn it.</div>`;
  }

  private authHeaders(): Record<string, string> {
    const token = this.requireSupervisorClient().config.token;
    return token ? { Authorization: "Bearer " + token } : {};
  }

  // Test-only hooks. Production boot doesn't reach these; vitest uses
  // them to drive merge + dispose scenarios without standing up real
  // WebSockets or HTTP mocks. The accessors are package-private by
  // convention (underscore prefix) — the public surface is still
  // show/hide/dispose/setTheme.
  _testApplyState(host: HostRef, state: MissionControlStateResponse): void {
    this.statesByHost.set(host, state);
    this.applyMergedState();
  }
  _testMergedCards(): HostTaggedCard[] {
    return this.mergeCards();
  }
  _testOpenWsCount(): number {
    return this.wss.size;
  }
  _testInstallMockWs(host: HostRef, ws: WebSocket): void {
    this.wss.set(host, ws);
  }
  /** Mirror the production onclose path for one host: drop the
   * socket, drop its cached state, re-apply, refresh status. */
  _testCloseHostWs(host: HostRef): void {
    this.wss.delete(host);
    if (this.statesByHost.has(host)) {
      this.statesByHost.delete(host);
      this.applyMergedState();
    }
    this.refreshStatusLine();
  }
  /** Fixup-round-2 test hooks. */
  _testSetVisible(v: boolean): void {
    this.visible = v;
  }
  _testOnCloseHost(host: HostRef): void {
    this.wss.delete(host);
    if (this.statesByHost.has(host)) {
      this.statesByHost.delete(host);
      this.applyMergedState();
    }
    this.refreshStatusLine();
    if (this.visible) this.scheduleReconnect(host);
  }
  _testReconnectPendingCount(): number {
    return this.reconnectTimers.size;
  }
  _testClearReconnects(): void {
    this.clearAllReconnectTimers();
  }
}

function renderPaneLine(p: HostTaggedPane): string {
  const state = p.agent_state || p.stoplight;
  // Host tag shown only for local panes, matching the tab-strip
  // convention: station is the visual default. Keeps single-host MC
  // layouts looking identical to pre-Phase-11.
  const hostBadge = p._host === "local"
    ? `<span class="pane-host-badge local" title="Running on local daemon">L</span>`
    : "";
  return `<li>
    ${hostBadge}
    <span class="pane-kind pane-kind-${escapeAttr(p.kind)}">${escapeHtml(p.kind)}</span>
    <span class="pane-state pane-state-${escapeAttr(state)}">${escapeHtml(humanState(p.agent_state, p.stoplight))}</span>
    ${p.session_name ? `<span class="pane-session">${escapeHtml(p.session_name)}</span>` : ""}
  </li>`;
}

function humanState(agentState: string, stoplight: Stoplight): string {
  if (agentState === "working") return "working";
  if (agentState === "attention") return "needs attention";
  if (agentState === "idle") return "idle";
  if (stoplight === "red") return "error";
  if (stoplight === "orange") return "attention";
  if (stoplight === "green") return "done";
  return "—";
}

function truncatePath(p: string): string {
  if (p.length <= 40) return p;
  return "…" + p.slice(-39);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
