import { test, expect } from '@playwright/test';
import { STORAGE_STATE } from './roles.ts';

// Cookies set by packages/backend/src/lib/response-builder.ts and cleared by
// packages/backend/src/handlers/auth-logout.ts.
const AUTH_COOKIES = ['hs_access_token', 'hs_id_token', 'hs_refresh_token', 'hs_logged_in'];

test('paid user logs out and session cookies are cleared', async ({ browser }) => {
  // Use an isolated context so logging out here cannot poison the shared paid
  // storageState used by other parallel tests.
  const context = await browser.newContext({ storageState: STORAGE_STATE.paid });
  const page = await context.newPage();

  await page.goto('/dashboard');
  await expect(page.getByText('Dashboard')).toBeVisible();

  await page.getByTestId('user-profile').click();
  await page.getByRole('button', { name: 'Log out' }).click();

  // Wait for the full /logout -> Auth0 /v2/logout -> returnTo chain to settle.
  await page.waitForURL(/^https:\/\/fil\.one\/?$/, { timeout: 30_000 });
  await expect(page).toHaveURL(/^https:\/\/fil\.one\/?$/);

  const cookies = await context.cookies();
  for (const name of AUTH_COOKIES) {
    expect(
      cookies.find((c) => c.name === name),
      `${name} should be cleared`,
    ).toBeUndefined();
  }

  // Server-side: a protected route should bounce to sign-in.
  await page.goto('/dashboard');
  await expect(page.getByText('Sign in')).toBeVisible();

  await context.close();
});
