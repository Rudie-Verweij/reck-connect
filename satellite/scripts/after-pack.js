// after-pack.js — bake RECK_STATION_ROOT into the .app's Info.plist.
//
// Why this exists: electron-builder's `${env.X}` template substitution
// only fires on a small set of YAML fields (productName, appId, etc.)
// — `extendInfo` is passed through untouched, so a value like
// `${env.RECK_STATION_ROOT}` lands in Info.plist verbatim. We need
// the actual value baked in at pack time so GUI launches inherit it
// via LSEnvironment without depending on `launchctl setenv`.
//
// This hook runs once per packaged platform (so once for arm64, once
// for x64 when we build both). PlistBuddy is part of macOS — no extra
// npm dep.

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

exports.default = async function afterPack(context) {
  const root = process.env.RECK_STATION_ROOT;
  if (!root) {
    throw new Error(
      "after-pack: RECK_STATION_ROOT must be set in the build env. " +
        "Either source ~/.config/reck/satellite.env first or use ops/build-app.sh.",
    );
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const plistPath = path.join(context.appOutDir, appName, "Contents", "Info.plist");

  if (!fs.existsSync(plistPath)) {
    throw new Error(`after-pack: Info.plist not found at ${plistPath}`);
  }

  // Idempotent: delete LSEnvironment first so we don't accumulate a
  // stale `${env.RECK_STATION_ROOT}` from electron-builder's
  // unsubstituted extendInfo (or from a previous run with a different
  // value). PlistBuddy `Delete` on a missing key is non-fatal as long
  // as we don't propagate its exit code.
  try {
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      "Delete :LSEnvironment",
      plistPath,
    ]);
  } catch {
    // not present yet — fine.
  }

  execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    "Add :LSEnvironment dict",
    "-c",
    `Add :LSEnvironment:RECK_STATION_ROOT string ${root}`,
    plistPath,
  ]);

  console.log(
    `  • after-pack  baked RECK_STATION_ROOT=${root} into ${path.relative(
      process.cwd(),
      plistPath,
    )}`,
  );
};
