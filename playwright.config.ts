import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: isCI ? "https://localhost:4173" : "https://localhost:5173",
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: isCI
      ? "pnpm --filter @hyperspace/website preview"
      : "pnpm --filter @hyperspace/website dev",
    url: isCI ? "https://localhost:4173" : "https://localhost:5173",
    reuseExistingServer: !isCI,
    ignoreHTTPSErrors: true,
    timeout: 120_000,
  },
});
