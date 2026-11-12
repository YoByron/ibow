import { defineConfig } from "@playwright/test";

/**
 * Browser tests of the customer flow against the real server (`src/server/main.ts`) on a temporary database.
 * Chromium only: @playwright/test is pinned to the version whose Chromium build is installed (D-012).
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  fullyParallel: true,
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { browserName: "chromium", locale: "en-US", trace: "retain-on-failure" },
  outputDir: "../runs/e2e",
});
