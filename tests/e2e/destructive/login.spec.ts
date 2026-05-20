import { test, expect } from '@playwright/test';

// Real UI login smoke test. Starts unauthenticated (no storageState) and exercises
// the Auth0 login form from scratch to guard the auth.setup.ts pathway from silent
// breakage. Only the paid user is exercised — other roles' auth is implicitly
// covered when their auth.setup.ts runs.
test.use({ storageState: { cookies: [], origins: [] } });

test('paid user signs in via Auth0 and lands on dashboard', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/login/);

  await page.locator('#username').fill(process.env.E2E_PAID_EMAIL!);
  await page.locator('button[data-action-button-primary="true"]').click();
  await page.locator('#password').fill(process.env.E2E_PAID_PASSWORD!);
  await page.locator('button[data-action-button-primary="true"]').click();
  await page.locator('button[value="abort-passkey-enrollment"]').click();

  await expect(page).toHaveURL(/\/dashboard$/);
  // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
});
