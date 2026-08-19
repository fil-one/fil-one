import { test, expect } from '@playwright/test';
import {
  AUTH0_DOMAIN_BY_CONSOLE_ORIGIN,
  getAuth0Domain,
  getStageFromHostname,
} from '@filone/shared';

const baseURL = process.env.BASE_URL;
if (!baseURL) {
  throw new Error('BASE_URL env var must be set (e.g., https://staging.fil.one)');
}

// Mirrors resolveAuth0Domain in the backend: the demo aliases authenticate against
// the Auth0 tenant domain rather than the stage's configured custom domain, so the
// origin table wins where it has an entry.
const { origin, hostname } = new URL(baseURL);
const expectedAuth0Domain =
  AUTH0_DOMAIN_BY_CONSOLE_ORIGIN[origin] ?? getAuth0Domain(getStageFromHostname(hostname));

test('login route redirects to Auth0 authorize for the deployment stage', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveURL(
    new RegExp(`^https://${expectedAuth0Domain.replace(/\./g, '\\.')}/`),
  );
});
