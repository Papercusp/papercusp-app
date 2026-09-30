import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import transportProfile from "./playwright.hosted-http1.config";
import { readHostedHttp1AcceptanceConfig } from "./e2e/_hosted-http1-config";

const acceptance = readHostedHttp1AcceptanceConfig();
const evidenceDir = join(acceptance.evidenceDir, "workspace-session");

/**
 * P-031 real-host profile. Reuses private auth, exact origin, SOCKS and serial
 * execution; keeps receipts separate from P-029's final evidence.
 * Supply PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE plus HOST_ID, WORKSPACE_ID,
 * WORKSPACE_ROOT and DESKTOP_SESSION_ID under the same environment prefix.
 * The existing host must be enrolled and advertise its websocket connector.
 *
 * npx playwright test --config apps/operator/playwright.hosted-workspace.config.ts
 */
export default defineConfig({
  ...transportProfile,
  testMatch: /hosted-workspace-acceptance\.live\.ts$/,
  timeout: 4 * 60_000,
  reporter: [
    ["list"],
    ["json", { outputFile: join(evidenceDir, "playwright-results.json") }],
  ],
  outputDir: join(evidenceDir, "artifacts"),
  // Retain only explicit receipts, never workspace screens or credentialed traces.
  use: {
    ...transportProfile.use,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
});
