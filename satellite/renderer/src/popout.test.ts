// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Popout-window bootstrap test . Asserts the contract
 * between `popout.ts` and the IPC surface:
 *
 *   - reads paneId/projectId/host from `reckAPI.windows.getDetachedPaneInfo`
 *   - resolves the daemon URL + token via `loadSettings`
 *   - constructs a TerminalPane with the right wsUrl + subprotocols
 *   - renders a header with a "Reattach" button that fires the IPC
 *
 * TerminalPane is mocked so vitest doesn't try to spin up xterm/WS;
 * we capture the props it was constructed with and assert on those.
 */

const constructed: Array<{ wsUrl: string; subprotocolsThunk: () => string[]; theme: unknown }> = [];

vi.mock("@client-core/terminal/terminal-pane", () => {
  class MockTerminalPane {
    container: HTMLElement;
    constructor(props: { wsUrl: string; wsSubprotocols?: () => string[]; theme?: unknown }) {
      this.container = document.createElement("div");
      // Mirror the real TerminalPane's constructor which sets
      // `pane-terminal` on `this.container`. Popout's body appends the
      // container directly (no extra wrapper) so the rendered selector
      // is `.popout-body .pane-terminal`.
      this.container.className = "pane-terminal";
      constructed.push({
        wsUrl: props.wsUrl,
        subprotocolsThunk:
          typeof props.wsSubprotocols === "function"
            ? (props.wsSubprotocols as () => string[])
            : () => [],
        theme: props.theme,
      });
    }
    mount() {}
    dispose() {}
    refit() {}
    focus() {}
    setTheme() {}
    /**
     * The real TerminalPane exposes its underlying xterm Terminal so the
     * file-viewer path linkifier (`installPathLinkProvider`) can hook into
     * it. The mock supplies the minimum shape the linkifier touches:
     * registerLinkProvider + a buffer that returns no lines.
     */
    getXterm() {
      return {
        registerLinkProvider: () => ({ dispose: () => {} }),
        buffer: { active: { getLine: () => undefined } },
      };
    }
  }
  return { TerminalPane: MockTerminalPane };
});

// Captured `onActivate` callbacks from the terminal path linkifier, so the
// anchoring tests can fire a click without a real xterm.
const pathLinkActivations: Array<(path: string) => void> = [];

vi.mock("./viewer/PathLinkProvider", () => ({
  installPathLinkProvider: (
    _xterm: unknown,
    opts: { onActivate: (path: string) => void },
  ) => {
    pathLinkActivations.push(opts.onActivate);
    return { dispose: () => {} };
  },
}));

// Swappable per test — the popout resolves its project cwd through
// ApiClient.listProjects().
let listProjectsImpl: () => Promise<{ projects: Array<{ id: string; cwd: string }> }> =
  async () => ({ projects: [] });

vi.mock("@client-core/api/client", () => ({
  ApiClient: class {
    listProjects() {
      return listProjectsImpl();
    }
    listSessions() {
      return Promise.resolve({ sessions: [] });
    }
  },
}));

interface MockReckAPI {
  config: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  daemon: {
    localToken: ReturnType<typeof vi.fn>;
  };
  windows: {
    detachPane: ReturnType<typeof vi.fn>;
    reattachPane: ReturnType<typeof vi.fn>;
    onPopoutClosed: ReturnType<typeof vi.fn>;
    getDetachedPaneInfo: ReturnType<typeof vi.fn>;
  };
}

function installMockReckAPI(overrides: Partial<MockReckAPI> = {}): MockReckAPI {
  const api: MockReckAPI = {
    config: {
      get: vi.fn(),
      set: vi.fn(),
    },
    daemon: {
      localToken: vi.fn().mockResolvedValue(null),
    },
    windows: {
      detachPane: vi.fn(),
      reattachPane: vi.fn().mockResolvedValue({ ok: true }),
      onPopoutClosed: vi.fn(),
      getDetachedPaneInfo: vi.fn().mockReturnValue(null),
    },
    ...overrides,
  };
  (window as unknown as { reckAPI: unknown }).reckAPI = api;
  return api;
}

async function importPopout(): Promise<void> {
  vi.resetModules();
  // Import the module — it kicks off `bootPopout()` at the bottom.
  // Awaiting the import lets the IIFE's microtasks settle.
  await import("./popout");
  // Allow the bootPopout() promise chain to settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  document.body.innerHTML = `<div id="popout" class="popout-shell"></div>`;
  document.documentElement.removeAttribute("data-theme");
  constructed.length = 0;
});

afterEach(() => {
  delete (window as unknown as { reckAPI?: unknown }).reckAPI;
});

describe("popout boot ", () => {
  it("renders an error when the URL has no pane info", async () => {
    installMockReckAPI({
      windows: {
        detachPane: vi.fn(),
        reattachPane: vi.fn(),
        onPopoutClosed: vi.fn(),
        getDetachedPaneInfo: vi.fn().mockReturnValue(null),
      },
    });
    await importPopout();
    const root = document.getElementById("popout");
    expect(root?.querySelector(".popout-error")?.textContent).toMatch(/missing pane id/);
    expect(constructed).toHaveLength(0);
  });

  it("builds the local-host wsUrl + subprotocols and mounts a TerminalPane", async () => {
    const api = installMockReckAPI({
      windows: {
        detachPane: vi.fn(),
        reattachPane: vi.fn().mockResolvedValue({ ok: true }),
        onPopoutClosed: vi.fn(),
        getDetachedPaneInfo: vi.fn().mockReturnValue({
          paneId: "pane-XYZ",
          projectId: "proj-1",
          host: "local",
          title: "shell-1",
        }),
      },
      daemon: {
        localToken: vi.fn().mockResolvedValue("local-token-abc"),
      },
    });
    api.config.get.mockImplementation(async (key: string) => {
      if (key === "settings") {
        return {
          local: { enabled: true, port: 7315, autoStart: true },
        };
      }
      if (key === "theme") return "dark";
      return null;
    });
    await importPopout();
    expect(constructed).toHaveLength(1);
    expect(constructed[0].wsUrl).toBe("ws://127.0.0.1:7315/ws/proj-1/pane-XYZ");
    expect(constructed[0].subprotocolsThunk()).toEqual(["reck-bearer.local-token-abc"]);
    expect(constructed[0].theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // Header rendered with the title from the URL.
    const title = document.querySelector(".popout-title");
    expect(title?.textContent).toBe("shell-1");
    // Body has the terminal wrapper.
    expect(document.querySelector(".popout-body .pane-terminal")).not.toBeNull();
  });

  it("builds a station wsUrl from settings.station.url + token", async () => {
    const api = installMockReckAPI({
      windows: {
        detachPane: vi.fn(),
        reattachPane: vi.fn().mockResolvedValue({ ok: true }),
        onPopoutClosed: vi.fn(),
        getDetachedPaneInfo: vi.fn().mockReturnValue({
          paneId: "pane-A",
          projectId: "proj-A",
          host: "station",
          title: null,
        }),
      },
      daemon: {
        localToken: vi.fn().mockResolvedValue(null),
      },
    });
    api.config.get.mockImplementation(async (key: string) => {
      if (key === "settings") {
        return {
          station: { enabled: true, url: "https://station.tail-net.ts/" },
          local: { enabled: true, port: 7315, autoStart: true },
        };
      }
      if (key === "station.token") return "station-token-zzz";
      if (key === "theme") return "light";
      return null;
    });
    await importPopout();
    expect(constructed).toHaveLength(1);
    expect(constructed[0].wsUrl).toBe("wss://station.tail-net.ts/ws/proj-A/pane-A");
    expect(constructed[0].subprotocolsThunk()).toEqual(["reck-bearer.station-token-zzz"]);
    // Title falls back to paneId when none is supplied.
    expect(document.querySelector(".popout-title")?.textContent).toBe("pane-A");
  });

  it("Reattach button invokes reckAPI.windows.reattachPane(paneId)", async () => {
    const api = installMockReckAPI({
      windows: {
        detachPane: vi.fn(),
        reattachPane: vi.fn().mockResolvedValue({ ok: true }),
        onPopoutClosed: vi.fn(),
        getDetachedPaneInfo: vi.fn().mockReturnValue({
          paneId: "pane-Q",
          projectId: "proj-Q",
          host: "local",
          title: "tab",
        }),
      },
      daemon: {
        localToken: vi.fn().mockResolvedValue("tok"),
      },
    });
    api.config.get.mockImplementation(async (key: string) => {
      if (key === "settings") {
        return { local: { enabled: true, port: 7315, autoStart: true } };
      }
      if (key === "theme") return "dark";
      return null;
    });
    await importPopout();
    const btn = document.querySelector<HTMLButtonElement>(".popout-actions button");
    expect(btn).not.toBeNull();
    btn!.click();
    expect(api.windows.reattachPane).toHaveBeenCalledWith("pane-Q");
  });

  it("renders an error when settings are missing", async () => {
    const api = installMockReckAPI({
      windows: {
        detachPane: vi.fn(),
        reattachPane: vi.fn(),
        onPopoutClosed: vi.fn(),
        getDetachedPaneInfo: vi.fn().mockReturnValue({
          paneId: "p",
          projectId: "proj",
          host: "local",
          title: null,
        }),
      },
    });
    api.config.get.mockResolvedValue(null);
    await importPopout();
    const err = document.querySelector(".popout-error");
    expect(err?.textContent).toMatch(/settings not configured/);
  });
});

/**
 * Path anchoring in detached windows.
 *
 * A popout used to hand `openInViewer` the raw click text with no
 * `projectCwd`, on the stated assumption that main would derive the project
 * anchor itself. Main can't: `rootRelativeCandidate()` short-circuits to null
 * without a cwd, so `docs/design/x.md` reached `isStationPathSafe()` still
 * relative and was rejected outright ("not an absolute POSIX path"). Bare
 * filenames failed the same way, leaving detached windows able to open only
 * already-absolute paths.
 */
describe("popout path anchoring", () => {
  const PANE_INFO = {
    paneId: "pane-1",
    projectId: "proj-1",
    host: "station" as const,
    title: "claude-1",
  };
  const CWD = "/home/strijders/projects/reck-connect";

  function installApi(overrides: Partial<MockReckAPI> = {}) {
    const api = installMockReckAPI({
      windows: {
        detachPane: vi.fn(),
        reattachPane: vi.fn().mockResolvedValue({ ok: true }),
        onPopoutClosed: vi.fn(),
        getDetachedPaneInfo: vi.fn().mockReturnValue(PANE_INFO),
      },
      ...overrides,
    });
    api.config.get.mockImplementation(async (key: string) => {
      if (key === "settings") {
        return { station: { enabled: true, url: "http://station:7315" } };
      }
      if (key === "theme") return "dark";
      return null;
    });
    (api as unknown as { files: unknown }).files = {
      openInViewer: vi.fn().mockResolvedValue({ ok: true }),
      resolve: vi.fn().mockResolvedValue([]),
    };
    return api;
  }

  function filesOf(api: MockReckAPI) {
    return (api as unknown as { files: { openInViewer: ReturnType<typeof vi.fn> } })
      .files;
  }

  /** Fire the terminal linkifier's activate callback captured via the mock. */
  function activate(path: string): void {
    const onActivate = pathLinkActivations.at(-1);
    if (!onActivate) throw new Error("installPathLinkProvider was never called");
    onActivate(path);
  }

  beforeEach(() => {
    pathLinkActivations.length = 0;
    listProjectsImpl = async () => ({
      projects: [{ id: "proj-1", cwd: CWD }],
    });
  });

  it("anchors a bare filename against the pane's project cwd", async () => {
    const api = installApi();
    await importPopout();
    activate("CLAUDE.md");
    expect(filesOf(api).openInViewer).toHaveBeenCalledWith(`${CWD}/CLAUDE.md`, {
      sourceHost: "station",
      originalText: "CLAUDE.md",
      projectCwd: CWD,
    });
  });

  it("anchors a root-relative path — the reported failure", async () => {
    const api = installApi();
    await importPopout();
    activate("docs/design/helpspot-sync.md");
    expect(filesOf(api).openInViewer).toHaveBeenCalledWith(
      `${CWD}/docs/design/helpspot-sync.md`,
      expect.objectContaining({ projectCwd: CWD }),
    );
  });

  it("collapses ./ and ../ segments while anchoring", async () => {
    const api = installApi();
    await importPopout();
    activate("./docs/../README.md");
    expect(filesOf(api).openInViewer).toHaveBeenCalledWith(
      `${CWD}/README.md`,
      expect.anything(),
    );
  });

  it("passes absolute paths through unchanged", async () => {
    const api = installApi();
    await importPopout();
    activate("/etc/hosts");
    expect(filesOf(api).openInViewer).toHaveBeenCalledWith(
      "/etc/hosts",
      expect.objectContaining({ originalText: "/etc/hosts" }),
    );
  });

  it("passes home-anchored paths through unchanged", async () => {
    // main's expandTildeForHost resolves `~` against the right home for the
    // host; prepending a cwd here would produce a literal `~` mid-path.
    const api = installApi();
    await importPopout();
    activate("~/notes.md");
    expect(filesOf(api).openInViewer).toHaveBeenCalledWith(
      "~/notes.md",
      expect.anything(),
    );
  });

  it("still opens absolute paths when the project lookup fails", async () => {
    // Degrades to the old behaviour rather than breaking the window.
    listProjectsImpl = async () => {
      throw new Error("daemon unreachable");
    };
    const api = installApi();
    await importPopout();
    activate("/abs/path.md");
    expect(filesOf(api).openInViewer).toHaveBeenCalledWith(
      "/abs/path.md",
      expect.objectContaining({ projectCwd: undefined }),
    );
  });

  it("does not invent a cwd when the pane's project isn't in the catalog", async () => {
    // A wrong cwd is worse than none: it poisons main's rescue pipeline.
    listProjectsImpl = async () => ({
      projects: [{ id: "some-other-project", cwd: "/elsewhere" }],
    });
    const api = installApi();
    await importPopout();
    activate("CLAUDE.md");
    expect(filesOf(api).openInViewer).toHaveBeenCalledWith(
      "CLAUDE.md",
      expect.objectContaining({ projectCwd: undefined }),
    );
  });
});
