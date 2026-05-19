/// <reference types="node" />

import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
const baseURL = process.env.BASE_URL;

if (!baseURL) {
  throw new Error(
    'BASE_URL env var is required. Deploy an SST stage first, then run: BASE_URL=<url> pnpm test:e2e',
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
  },
  projects: [
    // setup for disruptive tests
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    // `full-*` projects run both smoke and staging-only suites across all browsers.
    {
      name: 'full-chromium',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    {
      name: 'full-firefox',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Firefox'] },
      dependencies: ['setup'],
    },
    {
      name: 'full-webkit',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Safari'] },
      dependencies: ['setup'],
    },
    // smoke tests executed in production
    {
      name: 'smoke',
      testDir: './tests/e2e/smoke',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
