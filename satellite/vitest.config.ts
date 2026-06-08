import { defineConfig } from "vitest/config";
import path from "node:path";

// Seed env vars at config-load time so Vite's `import.meta.env`
// resolution (which runs before any setup file) sees them. The
// production code reads these at module-load time and throws on
// missing — without this seed, every test file would fail to import.
// `??=` keeps developer-supplied values untouched.
process.env.RECK_STATION_ROOT ??= "/Users/reck-connect/projects";
process.env.VITE_RECK_STATION_ROOT ??= "/Users/reck-connect/projects";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    // Vitest owns renderer/**/*.test.ts, main/**/*.test.ts (use vi.mock
    // to stub `electron` imports — no real Electron process is started),
    // and client-core source tests; Playwright owns e2e/**.
    include: [
      "renderer/**/*.test.ts",
      "main/**/*.test.ts",
      "../client-core/src/**/*.test.ts",
    ],
    exclude: ["e2e/**", "node_modules/**", "dist/**", "release/**"],
  },
  resolve: {
    alias: {
      "@proto": path.resolve(__dirname, "../proto"),
      "@client-core": path.resolve(__dirname, "../client-core/src"),
      // The xterm packages live in satellite/node_modules but are
      // imported from client-core sources (which have no local
      // node_modules). Without explicit aliases, vite's resolver
      // walks up from the client-core directory and fails before
      // vi.mock can intercept. Pinning the aliases to the satellite
      // copy fixes that — only vitest reads this config.
      "@xterm/xterm": path.resolve(
        __dirname,
        "node_modules/@xterm/xterm",
      ),
      "@xterm/addon-fit": path.resolve(
        __dirname,
        "node_modules/@xterm/addon-fit",
      ),
      "@xterm/addon-webgl": path.resolve(
        __dirname,
        "node_modules/@xterm/addon-webgl",
      ),
    },
  },
  server: {
    // Vitest's Vite instance must be allowed to read client-core sources
    // that sit one directory above satellite/.
    fs: {
      allow: [path.resolve(__dirname, ".."), path.resolve(__dirname)],
    },
  },
});
