// First-launch bootstrap import.
//
// The Claude-driven install choreography (INSTALL.md) ends with
// `install-satellite.sh --write-settings <token> <url>`, which drops a
// plain JSON file into the Satellite's userData dir:
//
//   <userData>/bootstrap.json
//     { "stationUrl": "...", "daemonToken": "..." }
//
// On first app launch we read that file, populate the encrypted
// settings.json via safeStorage (writeConfig handles encryption), and
// unlink the bootstrap file. This replaces the manual "paste token +
// URL into the first-launch dialog" step that the choreography is
// trying to remove.
//
// Idempotency: if `settings` is already on disk (returning user, or a
// re-run that races a second --write-settings invocation), we leave the
// existing config alone and just delete the bootstrap file. We never
// overwrite a populated settings blob.

const DEFAULT_LOCAL_PORT = 7315;

export interface ImportedSettings {
  station: { enabled: boolean; url: string };
  local: { enabled: boolean; port: number; autoStart: boolean };
}

export interface BootstrapImportIo {
  readBootstrap: () => string | null;
  removeBootstrap: () => void;
  hasSettings: () => boolean;
  hasStationToken: () => boolean;
  writeSettings: (settings: ImportedSettings) => void;
  writeStationToken: (token: string) => void;
  log: (msg: string) => void;
}

export type BootstrapImportResult =
  | { imported: false; reason: "no-bootstrap" }
  | { imported: false; reason: "already-configured" }
  | { imported: false; reason: "malformed"; detail: string }
  | { imported: false; reason: "token-write-failed"; detail: string }
  | { imported: true; settings: ImportedSettings };

export function planBootstrapImport(io: BootstrapImportIo): BootstrapImportResult {
  const raw = io.readBootstrap();
  if (raw === null) {
    return { imported: false, reason: "no-bootstrap" };
  }

  // Existing user with BOTH settings AND station.token populated — the
  // bootstrap file is stale, drop it. We require both so a partial
  // earlier import (settings written, secret-write threw because
  // safeStorage was momentarily unavailable) doesn't get permanently
  // discarded by a later launch that finds settings present and
  // assumes the import "already ran".
  if (io.hasSettings() && io.hasStationToken()) {
    io.log(
      "bootstrap import: settings.json + station.token already populated, removing bootstrap.json without import",
    );
    io.removeBootstrap();
    return { imported: false, reason: "already-configured" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      imported: false,
      reason: "malformed",
      detail: `parse error: ${(e as Error).message}`,
    };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { imported: false, reason: "malformed", detail: "not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const url = obj.stationUrl;
  const token = obj.daemonToken;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    return {
      imported: false,
      reason: "malformed",
      detail: "missing or invalid stationUrl (expected http(s)://...)",
    };
  }
  if (typeof token !== "string" || token.length === 0) {
    return {
      imported: false,
      reason: "malformed",
      detail: "missing or empty daemonToken",
    };
  }

  const settings: ImportedSettings = {
    station: { enabled: true, url },
    local: { enabled: true, port: DEFAULT_LOCAL_PORT, autoStart: true },
  };

  // Transactional ordering: secret first. If writeStationToken throws
  // (safeStorage refusal), we surface it and DO NOT write the
  // non-secret settings nor unlink bootstrap.json. The next launch
  // finds settings absent + bootstrap present and tries again.
  try {
    io.writeStationToken(token);
  } catch (e) {
    return {
      imported: false,
      reason: "token-write-failed",
      detail: (e as Error).message,
    };
  }
  io.writeSettings(settings);
  io.removeBootstrap();
  io.log(`bootstrap import: imported station url=${JSON.stringify(url)}`);
  return { imported: true, settings };
}
