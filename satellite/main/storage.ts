import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

const CONFIG_DIR = () => path.join(app.getPath("userData"), "config");
const CONFIG_FILE = () => path.join(CONFIG_DIR(), "settings.json");

type ConfigBlob = Record<string, string>; // values are base64(encrypted-JSON) strings

/**
 * Allowlist of keys that the renderer may persist via `config:get` /
 * `config:set` IPC. The IPC handler enforces this at the trust boundary —
 * see `main.ts`. Adding a new persistent renderer setting requires:
 *   1. Adding the key here.
 *   2. Wiring the renderer use site through `window.reckAPI.config.{get,set}`.
 *   3. If the value carries secret material, also add it to
 *      `SECRET_CONFIG_KEYS` so unencrypted persistence is refused.
 *
 * The previous tuple lived in `main.ts` but had no runtime enforcement; a
 * compromised renderer could persist arbitrary JSON under arbitrary keys.
 * Keeping the allowlist beside the storage layer means the secret/non-secret
 * relationship is testable without an Electron mock.
 *
 * `layouts` (unprefixed) is the legacy single-pane layout key from before
 * `layouts_v2`. Kept allowlisted so old configs can still round-trip during
 * read; no renderer call site writes to it today.
 */
export const CONFIG_KEYS = [
  // Hybrid mode (an earlier release, plan rev 3.1) Phase 2 — single JSON blob
  // carrying the new `Settings` shape:
  //   { station?: { enabled, url }, local?: { enabled, port, autoStart } }
  // The station bearer token is persisted separately under
  // "station.token" (secret) so the safeStorage refusal path only
  // blocks the secret half. Layouts use this same one-key pattern
  // (`layouts_v2`) — keeping settings as a single blob lets the
  // migration write atomically rather than juggling six dotted keys.
  "settings",
  "station.token",
  // Legacy keys (pre-Phase-2): held one release for rollback. The Phase 2
  // migration in main.ts reads these once at startup, writes "settings"
  // + "station.token", and leaves the legacy entries in place. A
  // subsequent release deletes them. Until then, keeping them allowlisted
  // means a downgrade still finds its config.
  "mode",
  "stationUrl",
  "daemonToken",
  "layouts",
  "layouts_v2",
  "railWidth",
  // Rail collapse redesign: persisted mode ("expanded"|"mini") plus the
  // project-switch separator-wiggle tuning. Without these entries the
  // IPC boundary silently rejects the renderer's get/set (the exact
  // failure mode reckConnectPrompt hit before it was allowlisted).
  "railMode",
  "railWiggleEnabled",
  "railWigglePixels",
  "railWiggleLegMs",
  "theme",
  "projectNames",
  "projectOrder",
  "claudeLaunchArgs",
  "claudeLaunchArgsByProject",
  // an earlier release — hover-to-focus panes. Surfaced in Preferences since
  // Default ON since an earlier release. Persisted as boolean; renderer treats explicit
  // `false` as opt-out and any other value as the default.
  "hoverToFocus",
  // Text-to-speech preferences: { voice: string|null, rate: number }.
  // Non-secret. Defaults applied at load time so a missing key is fine.
  "tts",
  // App-wide prompt text auto-appended to every Claude pane. Was written
  // by the renderer without being allowlisted — the IPC boundary silently
  // rejected every save (caught by the config-keys sweep test).
  "reckConnectPrompt",
  // File-viewer / Cmd+click linkifier settings. Without these allowlisted,
  // the IPC boundary silently rejects every config:get/config:set for them.
  // `fileViewerExtraRoots`: user-added folders the viewer may open outside
  // the built-in roots. `fileViewerModePerPath`: remembered source-vs-rendered
  // choice per file. `linkifier.extensionlessAllowlist`: extensionless
  // filenames (e.g. Dockerfile, Makefile) the terminal linkifier treats as
  // clickable.
  "fileViewerExtraRoots",
  "fileViewerModePerPath",
  "linkifier.extensionlessAllowlist",
  // Drag-drop into a pane: user-editable allowed file extensions, and the
  // configurable prompt template inserted (as a bracketed paste) when a
  // file is dropped into the project root. Without these allowlisted the
  // IPC boundary silently rejects the renderer's get/set.
  "dragDrop.allowedExtensions",
  "dragDrop.promptTemplate",
  // Voice dictation (issue #67). Non-secret prefs blob:
  //   { enabled, provider, localModel, hotkeyToggle, hotkeyPushToTalk, autoSubmit }.
  // The Deepgram API key is held separately under the secret key
  // "transcription.deepgramKey" so the safeStorage refusal path only
  // blocks the secret half (same split as settings / station.token).
  "transcription",
  "transcription.deepgramKey",
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

const CONFIG_KEY_SET: ReadonlySet<string> = new Set(CONFIG_KEYS);

export function isAllowedConfigKey(key: unknown): key is ConfigKey {
  return typeof key === "string" && CONFIG_KEY_SET.has(key);
}

/**
 * Keys that carry secret material. When Electron's `safeStorage` encryption
 * is unavailable (e.g. keychain inaccessible, Linux without a libsecret
 * backend, etc.) we refuse to write these rather than silently base64-
 * encoding the plaintext — matching the codebase's "bail on unsafe state"
 * pattern. The user is forced to re-enter the token every session, which is
 * the defensible failure mode for a station bearer token.
 *
 * Invariant: every entry here MUST also appear in `CONFIG_KEYS`. The unit
 * tests assert this so a future secret can't be added without also being
 * allowlisted at the IPC boundary.
 */
// Both the legacy `daemonToken` key (held for one-release rollback) and
// the new `station.token` key (Phase 2) carry the station's bearer token
// in plaintext when decrypted, so both must encrypt at rest. The unit
// test asserts these are also present in `CONFIG_KEYS` so a future entry
// can't be added in one place without the other.
const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "daemonToken",
  "station.token",
  // The user's Deepgram API key — plaintext when decrypted, so it must
  // encrypt at rest. Stored apart from the "transcription" prefs blob.
  "transcription.deepgramKey",
]);

export function listSecretConfigKeys(): ReadonlySet<string> {
  return SECRET_CONFIG_KEYS;
}

function isSecretKey(key: string): boolean {
  return SECRET_CONFIG_KEYS.has(key);
}

function readBlob(): ConfigBlob {
  try {
    const raw = fs.readFileSync(CONFIG_FILE(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeBlob(blob: ConfigBlob) {
  fs.mkdirSync(CONFIG_DIR(), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(blob, null, 2), "utf8");
}

// Log once per process if we detect unavailable encryption, so the warning
// appears in the main-process log without spamming every read/write.
let warnedAboutUnavailableEncryption = false;
function warnUnavailableOnce() {
  if (warnedAboutUnavailableEncryption) return;
  warnedAboutUnavailableEncryption = true;
  console.warn(
    "[satellite] safeStorage encryption is unavailable; secret config " +
      "values will be refused (user will be prompted to re-enter each session)",
  );
}

/**
 * Presence-check that doesn't decode. Used by the Phase 2 settings
 * migration to short-circuit re-runs: a key with a deliberately-empty
 * value (e.g. `{}` for the new `settings` blob) still counts as "this
 * was already migrated"; readConfig returning null for an undecryptable
 * secret would falsely trigger a re-migration.
 */
export function hasConfigKey(key: string): boolean {
  const blob = readBlob();
  return Object.prototype.hasOwnProperty.call(blob, key);
}

export function readConfig(key: string): unknown {
  const blob = readBlob();
  const enc = blob[key];
  if (!enc) return null;
  const buf = Buffer.from(enc, "base64");
  const encryptionAvailable = safeStorage.isEncryptionAvailable();

  if (isSecretKey(key) && !encryptionAvailable) {
    // We deliberately do NOT decode any previously-stored plaintext secret:
    // that would perpetuate the exact fallback we're trying to kill. Tell
    // the user they need to re-enter.
    warnUnavailableOnce();
    return null;
  }

  try {
    const dec = encryptionAvailable
      ? safeStorage.decryptString(buf)
      : buf.toString("utf8");
    return JSON.parse(dec);
  } catch {
    return null;
  }
}

/**
 * Persist `value` under `key`. Throws when `key` is a secret (see
 * `SECRET_CONFIG_KEYS`) and `safeStorage` encryption is unavailable; the
 * IPC handler surfaces that as a rejected promise so the renderer can show
 * the user a "couldn't save token — re-enter next session" warning.
 */
export function writeConfig(key: string, value: unknown): void {
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  if (isSecretKey(key) && !encryptionAvailable) {
    warnUnavailableOnce();
    console.warn(
      `[satellite] refused to persist secret config key ${JSON.stringify(key)}: ` +
        "safeStorage encryption unavailable",
    );
    throw new Error(
      `cannot persist ${key}: OS keychain/encryption unavailable. ` +
        "You'll need to re-enter this value each session.",
    );
  }

  const blob = readBlob();
  const str = JSON.stringify(value);
  const buf = encryptionAvailable
    ? safeStorage.encryptString(str)
    : Buffer.from(str, "utf8");
  blob[key] = buf.toString("base64");
  writeBlob(blob);
}
