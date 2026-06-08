// Hybrid mode (an earlier release, plan rev 3.1) Phase 2 migration.
//
// Folds the legacy `mode` / `stationUrl` / `daemonToken` triplet into the
// new `Settings` shape:
//
//   { station?: { enabled, url, token? }, local?: { enabled, port, autoStart } }
//
// The non-secret half is persisted under the single key "settings"; the
// station bearer token stays in its own secret key "station.token" so the
// safeStorage refusal path only blocks the secret half (matches the
// recommendation in the Phase 2 plan).
//
// Idempotency: bail early when the new "settings" key is already present.
// Legacy keys are left in place for one release as a rollback path —
// deletion happens in a follow-up.
//
// For `mode === "local"` users we read `~/.config/reck/projects.toml`
// before the migration and log every project ID found. The local-daemon
// side of hybrid will surface those projects via station-side push (Phase
// 9), so a user who had no-station projects loses visibility to them
// here. Logging gives them a recovery trail; the toml is never deleted.
//
// All disk reads are wrapped in try/catch — a missing or unparseable
// `projects.toml` (perfectly normal for fresh users) downgrades to a
// debug log and the migration continues.

const DEFAULT_LOCAL_PORT = 7315;

export interface MigratedSettings {
  station?: { enabled: boolean; url: string };
  local?: { enabled: boolean; port: number; autoStart: boolean };
}

export interface MigrationResult {
  migrated: boolean;
  reason: "fresh-install" | "already-migrated" | "from-station" | "from-local";
  settings?: MigratedSettings;
  // Set when from-station: the migrator wrote the secret token under the
  // new key. Caller must call its secret-write path (which can throw if
  // safeStorage is down). Empty string means "no token to migrate".
  stationTokenToWrite?: string;
  // Set when from-local: the project IDs we found in ~/.config/reck/projects.toml.
  // Logged by the migrator; surfaced here for callers/tests.
  loggedLocalProjectIds?: string[];
}

export interface MigrationIo {
  readKey: (key: string) => unknown;
  hasKey: (key: string) => boolean;
  readProjectsToml: () => string | null;
  log: (msg: string) => void;
}

/**
 * Pure migration logic. Decides what the new shape should be based on
 * the legacy keys, returns a `MigrationResult` describing the action;
 * does NOT write anything. The caller (`runSettingsMigration` in
 * main.ts) owns the writes so the secret-write path can throw without
 * making this function partial.
 */
export function planMigration(io: MigrationIo): MigrationResult {
  // Idempotency check: if the new shape is already persisted, bail.
  // We check `hasKey` (presence on disk) rather than `readKey`-truthiness
  // because a deliberate "{}" save is still a successful migration —
  // re-running would clobber the user's empty config back to whatever
  // the legacy keys looked like at boot.
  if (io.hasKey("settings")) {
    return { migrated: false, reason: "already-migrated" };
  }

  const rawMode = io.readKey("mode");
  const mode =
    typeof rawMode === "string" && (rawMode === "station" || rawMode === "local")
      ? rawMode
      : null;

  if (mode === null) {
    // Fresh install — no legacy data, no migration. The renderer's
    // loadSettings() returns null and the mode-chooser renders.
    return { migrated: false, reason: "fresh-install" };
  }

  if (mode === "station") {
    const rawUrl = io.readKey("stationUrl");
    const url = typeof rawUrl === "string" ? rawUrl : "";
    const rawToken = io.readKey("daemonToken");
    const token = typeof rawToken === "string" ? rawToken : "";
    io.log(
      `phase 2 migration: from-station url=${JSON.stringify(url)} token=${token ? "<set>" : "<empty>"}`,
    );
    return {
      migrated: true,
      reason: "from-station",
      settings: {
        station: { enabled: true, url },
        // an earlier release — local is always available now. From-station
        // migrations enable local with autoStart so a user upgrading
        // off the legacy single-mode `station` setting lands in true
        // hybrid (station + always-on local) rather than station-only.
        // Same defaults as a fresh install.
        local: { enabled: true, port: DEFAULT_LOCAL_PORT, autoStart: true },
      },
      stationTokenToWrite: token,
    };
  }

  // mode === "local". Enumerate projects.toml first so the user has a
  // recovery trail of any project IDs that won't survive into hybrid.
  const tomlBody = io.readProjectsToml();
  const ids: string[] = tomlBody ? extractProjectIdsFromToml(tomlBody) : [];
  if (tomlBody === null) {
    io.log("phase 2 migration: from-local — projects.toml missing or unreadable");
  } else if (ids.length === 0) {
    io.log("phase 2 migration: from-local — projects.toml has no [[projects]] entries");
  } else {
    io.log(
      `phase 2 migration: from-local — projects.toml lists ${ids.length} project(s) you may lose visibility to in hybrid mode:`,
    );
    for (const id of ids) {
      io.log(`  - ${id}`);
    }
    io.log(
      "  (the toml is left on disk; a future feature may re-surface these — see plan rev 3.1 §Persisted-state migration)",
    );
  }

  return {
    migrated: true,
    reason: "from-local",
    settings: {
      local: { enabled: true, port: DEFAULT_LOCAL_PORT, autoStart: true },
      // Per plan: station unset on from-local migration.
    },
    loggedLocalProjectIds: ids,
  };
}

/**
 * Hand-roll a minimal TOML scan rather than pulling a parser dep. We
 * only care about the `id` field of `[[projects]]` blocks; everything
 * else (cwd, claude_args, …) is irrelevant to the rev-3.1 logging
 * recovery trail.
 *
 * The grammar we accept:
 *
 *   [[projects]]
 *   id = "some-id"
 *   id = 'single-quoted-id'
 *
 * And its forgiving variants:
 *   - whitespace anywhere reasonable
 *   - any number of lines between header and id (we scan the *next* id
 *     line per header; the canonical projects.toml writes id immediately
 *     after the header)
 *   - id values containing escape sequences are returned as-typed (no
 *     unescape — we don't surface them as filesystem paths)
 *
 * Anything outside this surface is silently skipped — the caller treats
 * the empty result as "no projects" and the migration proceeds.
 */
export function extractProjectIdsFromToml(body: string): string[] {
  const ids: string[] = [];
  const lines = body.split(/\r?\n/);
  let inProjects = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (/^\[\[\s*projects\s*\]\]\s*$/.test(line)) {
      inProjects = true;
      continue;
    }
    if (line.startsWith("[")) {
      // Any other table header (`[other]` / `[[other]]`) ends the
      // current projects scope.
      inProjects = false;
      continue;
    }
    if (!inProjects) continue;
    const m = /^id\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (m) {
      ids.push(m[1] ?? m[2] ?? "");
      // Done with this projects block — until the next `[[projects]]`
      // header, ignore everything (multiple `id` lines in one block
      // would be an invalid TOML anyway, and our writer never emits
      // that shape).
      inProjects = false;
    }
  }
  return ids;
}
