/// <reference types="node" />

import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Credentials for the bucket policy suite, written by bin/e2e-register-policy-users.ts.
if (existsSync('.env.e2e.local')) process.loadEnvFile('.env.e2e.local');

const isCI = !!process.env.CI;
// Policy specs that change what other specs see: member-ui reads the member's
// whole bucket list, lifecycle changes the roster. They run alone, after the rest.
const SERIAL_POLICY_SPECS = /(policy-member-ui|policy-lifecycle)\.spec\.ts$/;
// Policy tests that open a page; Firefox and WebKit run only these.
const PAGE_POLICY_TESTS = /\b(M[1-5]|K[12]|PU[1-3]|R7|S[34]|U\d+[ab]?)\. /;
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
  reporter: [['list'], ['html']],
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
    // The staging-only suites, per browser. Smoke runs in its own project below.
    {
      name: 'full-chromium',
      testDir: './tests/e2e',
      testIgnore: /(multi-org|policies|smoke)\//,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['seed-buckets'],
    },
    {
      name: 'full-firefox',
      testDir: './tests/e2e',
      testIgnore: /(multi-org|policies|smoke)\//,
      use: { ...devices['Desktop Firefox'] },
      dependencies: ['seed-buckets'],
    },
    {
      name: 'full-webkit',
      testDir: './tests/e2e',
      testIgnore: /(multi-org|policies|smoke)\//,
      use: { ...devices['Desktop Safari'] },
      dependencies: ['seed-buckets'],
    },
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
        ['multi-org', 'Desktop Chrome'],
        ['multi-org-firefox', 'Desktop Firefox'],
        ['multi-org-webkit', 'Desktop Safari'],
      ] as const
    ).map(([name, device]) => ({
      name,
      testDir: './tests/e2e/multi-org',
      fullyParallel: false,
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
            testMatch: /policies\/policies\.setup\.ts/,
            // The seat test activates the billing row the owner's login creates.
            fullyParallel: false,
            workers: 1,
          },
          // Every spec but the serial ones, one project per browser. Spec files
          // run side by side (each makes its own buckets and keys); the tests in
          // a file stay in order. Firefox and WebKit run only the page tests.
          ...(
            [
              ['policies', 'Desktop Chrome', undefined],
              ['policies-firefox', 'Desktop Firefox', PAGE_POLICY_TESTS],
              ['policies-webkit', 'Desktop Safari', PAGE_POLICY_TESTS],
            ] as const
          ).map(([name, device, grep]) => ({
            name,
            testDir: './tests/e2e/policies',
            testIgnore: SERIAL_POLICY_SPECS,
            grep,
            use: { ...devices[device] },
            fullyParallel: false,
            dependencies: ['policies-setup'],
          })),
          // The serial specs, one browser after another, once every project
          // above has finished. `--project=policies-serial-webkit` runs the lot.
          ...(
            [
              ['policies-serial', 'Desktop Chrome', undefined],
              ['policies-serial-firefox', 'Desktop Firefox', PAGE_POLICY_TESTS],
              ['policies-serial-webkit', 'Desktop Safari', PAGE_POLICY_TESTS],
            ] as const
          ).map(([name, device, grep], i, all) => ({
            name,
            testDir: './tests/e2e/policies',
            testMatch: SERIAL_POLICY_SPECS,
            grep,
            use: { ...devices[device] },
            fullyParallel: false,
            workers: 1,
            dependencies:
              i === 0 ? ['policies', 'policies-firefox', 'policies-webkit'] : [all[i - 1][0]],
          })),
        ]
      : []),
    // smoke tests executed in production
    {
      name: 'smoke',
      testDir: './tests/e2e/smoke',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
