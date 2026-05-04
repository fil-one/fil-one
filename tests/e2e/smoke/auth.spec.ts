import { test, expect } from '@playwright/test';
import { getAuth0Domain, getStageFromHostname } from '@filone/shared';

const baseURL = process.env.BASE_URL;
if (!baseURL) {
  throw new Error('BASE_URL env var must be set (e.g., https://staging.fil.one)');
}

const expectedAuth0Domain = getAuth0Domain(getStageFromHostname(new URL(baseURL).hostname));

test('login route redirects to Auth0 authorize for the deployment stage', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveURL(
    new RegExp(`^https://${expectedAuth0Domain.replace(/\./g, '\\.')}/`),
  );
});
