import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
const baseURL = process.env.BASE_URL;

if (!baseURL) {
  throw new Error(
    'BASE_URL env var is required. Deploy an SST stage first, then run: BASE_URL=<url> pnpm test:e2e',
  );
}

const REQUIRED_CREDENTIAL_VARS = [
  'E2E_PAID_EMAIL',
  'E2E_PAID_PASSWORD',
  'E2E_PAID_USER_ID',
  'E2E_UNPAID_EMAIL',
  'E2E_UNPAID_PASSWORD',
  'E2E_UNPAID_USER_ID',
  'E2E_TRIAL_EMAIL',
  'E2E_TRIAL_PASSWORD',
  'E2E_TRIAL_USER_ID',
] as const;

const missingCredentials = REQUIRED_CREDENTIAL_VARS.filter((name) => !process.env[name]);
if (missingCredentials.length > 0) {
  throw new Error(
    `Missing required E2E credential env vars: ${missingCredentials.join(', ')}. ` +
      `See README.md for details.`,
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
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      dependencies: ['setup'],
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      dependencies: ['setup'],
    },
  ],
});
