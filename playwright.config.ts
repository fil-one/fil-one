/// <reference types="node" />

import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Credentials for the bucket policy suite, written by bin/e2e-register-policy-users.ts.
if (existsSync('.env.e2e.local')) process.loadEnvFile('.env.e2e.local');

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
    // Seeds a bucket per region for the roles that need one. Separate from the
    // `setup` project because it reuses the storage state that project writes.
    {
      name: 'seed-buckets',
      testMatch: /buckets\.setup\.ts/,
      dependencies: ['setup'],
    },
    // `full-*` projects run both smoke and staging-only suites across all browsers.
    {
      name: 'full-chromium',
      testDir: './tests/e2e',
      testIgnore: /policies\//,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['seed-buckets'],
    },
    {
      name: 'full-firefox',
      testDir: './tests/e2e',
      testIgnore: /policies\//,
      use: { ...devices['Desktop Firefox'] },
      dependencies: ['seed-buckets'],
    },
    {
      name: 'full-webkit',
      testDir: './tests/e2e',
      testIgnore: /policies\//,
      use: { ...devices['Desktop Safari'] },
      dependencies: ['seed-buckets'],
    },
    // Bucket policies, against a local stage whose us-east-9 region serves the
    // `iam` access model from smelt (tests/e2e/policies/README.md).
    {
      name: 'policies-setup',
      testMatch: /policies\/policies\.setup\.ts/,
    },
    {
      name: 'policies-local',
      testDir: './tests/e2e/policies',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['policies-setup'],
    },
    // smoke tests executed in production
    {
      name: 'smoke',
      testDir: './tests/e2e/smoke',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
