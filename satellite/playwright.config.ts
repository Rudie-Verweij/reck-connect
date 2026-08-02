import { defineConfig } from "@playwright/test";

// Dev-server port for the harness pages. Overridable because 5173 is Vite's
// default across every project on the machine: when another repo's dev server
// already owns it, `reuseExistingServer` happily reuses THAT one and the whole
// suite runs against someone else's app, failing in ways that look like our
// bugs. `RECK_E2E_PORT=5199 pnpm test:e2e` gets you off the contested port.
export const E2E_PORT = Number(process.env.RECK_E2E_PORT ?? 5173);
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: E2E_ORIGIN,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec vite --port ${E2E_PORT} --strictPort`,
    port: E2E_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
