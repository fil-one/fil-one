import { test, expect } from '@playwright/test';
import { getAuth0Domain } from '@filone/shared';

const stage = process.env.STAGE;
if (!stage) {
  throw new Error('STAGE env var must be set (e.g., staging, production, pr-42)');
}

const expectedAuth0Domain = getAuth0Domain(stage);

test('login route redirects to Auth0 authorize for the deployment stage', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveURL(
    new RegExp(`^https://${expectedAuth0Domain.replace(/\./g, '\\.')}/`),
  );
});
