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
  // Ends the run before the CI job's 30-minute timeout, so the report still uploads.
  globalTimeout: isCI ? 25 * 60_000 : undefined,
  // The html reporter prints nothing, so Playwright adds its own terminal
  // reporter: one dot per test on CI. CI logs list each test by name instead.
  reporter: isCI ? [['list'], ['html']] : 'html',
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
  },
  projects: [
    // Project names follow `<suite>-<browser>`, where the suite is the
    // directory under tests/e2e, so `--project='<suite>-*'` selects a suite.
    //
    // setup for disruptive tests
    {
      name: 'destructive-setup',
      testDir: './tests/e2e/destructive',
      testMatch: /auth\.setup\.ts/,
    },
    // Seeds a bucket per region for the roles that need one. Separate from the
    // setup project because it reuses the storage state that project writes.
    {
      name: 'destructive-seed-buckets',
      testDir: './tests/e2e/destructive',
      testMatch: /buckets\.setup\.ts/,
      dependencies: ['destructive-setup'],
    },
    // The staging-only suite, per browser.
    ...(
      [
        ['destructive-chromium', 'Desktop Chrome'],
        ['destructive-firefox', 'Desktop Firefox'],
        ['destructive-webkit', 'Desktop Safari'],
      ] as const
    ).map(([name, device]) => ({
      name,
      testDir: './tests/e2e/destructive',
      use: { ...devices[device] },
      dependencies: ['destructive-seed-buckets'],
    })),
    // The multi-org suite, on its own accounts. Serial: the specs share them.
    {
      name: 'multi-org-setup',
      testDir: './tests/e2e/multi-org',
      testMatch: /login\.setup\.ts/,
    },
    // One project per browser. The specs reset the accounts they change, so
    // they run again after one setup.
    ...(
      [
        ['multi-org-chromium', 'Desktop Chrome'],
        ['multi-org-firefox', 'Desktop Firefox'],
        ['multi-org-webkit', 'Desktop Safari'],
      ] as const
    ).map(([name, device]) => ({
      name,
      testDir: './tests/e2e/multi-org',
      fullyParallel: false,
      workers: 1,
      // Lambdas start cold.
      timeout: 90_000,
      expect: { timeout: 20_000 },
      use: {
        ...devices[device],
        trace: 'retain-on-failure' as const,
        screenshot: 'only-on-failure' as const,
      },
      dependencies: ['multi-org-setup'],
    })),
    // Bucket policies, against a stage whose Forge region serves the `iam`
    // access model: us-east-9 from smelt locally, eu-central-3 on a remote stage
    // (tests/e2e/policies/README.md). Only offered when the policy users are
    // registered: the specs read their credentials at load.
    ...(process.env.E2E_POLICY_OWNER_EMAIL
      ? [
          {
            name: 'policies-setup',
            testDir: './tests/e2e/policies',
            testMatch: /policies\.setup\.ts/,
            // The seat test activates the billing row the owner's login creates.
            fullyParallel: false,
            workers: 1,
          },
          // Tags in the specs pick the project: `@serial` tests change what other
          // tests see and run alone, after the rest; `@api` tests open no page, so
          // they run in Chromium only. Every other test runs in all three browsers.
          //
          // Spec files run side by side (each makes its own buckets and keys); the
          // tests in a file stay in order.
          ...(
            [
              ['policies-chromium', 'Desktop Chrome', /@serial/],
              ['policies-firefox', 'Desktop Firefox', /@serial|@api/],
              ['policies-webkit', 'Desktop Safari', /@serial|@api/],
            ] as const
          ).map(([name, device, grepInvert]) => ({
            name,
            testDir: './tests/e2e/policies',
            grepInvert,
            use: { ...devices[device] },
            fullyParallel: false,
            dependencies: ['policies-setup'],
          })),
          // The `@serial` tests, one browser after another, once every project
          // above has finished.
          ...(
            [
              ['policies-serial-chromium', 'Desktop Chrome', undefined],
              ['policies-serial-firefox', 'Desktop Firefox', /@api/],
              ['policies-serial-webkit', 'Desktop Safari', /@api/],
            ] as const
          ).map(([name, device, grepInvert], i, all) => ({
            name,
            testDir: './tests/e2e/policies',
            grep: /@serial/,
            grepInvert,
            use: { ...devices[device] },
            fullyParallel: false,
            workers: 1,
            dependencies:
              i === 0
                ? ['policies-chromium', 'policies-firefox', 'policies-webkit']
                : [all[i - 1][0]],
          })),
        ]
      : []),
    // smoke tests executed in production
    {
      name: 'smoke-chromium',
      testDir: './tests/e2e/smoke',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
