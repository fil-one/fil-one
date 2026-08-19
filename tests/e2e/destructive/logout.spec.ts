import { test, expect } from '@playwright/test';
import { STORAGE_STATE } from './roles.util.ts';

// Cookies set by packages/backend/src/lib/response-builder.ts and cleared by
// packages/backend/src/handlers/auth-logout.ts.
const AUTH_COOKIES = ['hs_access_token', 'hs_id_token', 'hs_refresh_token', 'hs_logged_in'];

test('paid user logs out and session cookies are cleared', async ({ browser }) => {
  // Use an isolated context so logging out here cannot poison the shared paid
  // storageState used by other parallel tests.
  const context = await browser.newContext({ storageState: STORAGE_STATE.paid });
  const page = await context.newPage();

  // The returnTo landing is only a waypoint — the console root bounces an unauthenticated
  // visitor on to the sign-in screen — so record the chain rather than assert a final URL.
  const visited: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(frame.url());
  });

  await page.goto('/dashboard');
  await expect(page.locator('#dashboard-heading')).toBeVisible();

  await page.getByTestId('user-profile').click();
  await page.locator('#user-menu-logout-button').click();

  // Wait for the full /logout -> Auth0 /v2/logout -> returnTo -> sign-in chain to settle.
  await page.waitForURL(/login/, { timeout: 30_000 });

  // Non-production stages log out to their own console (logoutReturnTo in
  // @filone/shared), so you can sign straight back in as a different user. Landing on
  // the production marketing site instead is the regression this guards.
  const consoleOrigin = new URL(process.env.BASE_URL!).origin;
  expect(visited.some((url) => new URL(url).origin === consoleOrigin)).toBe(true);
  expect(visited.some((url) => /^https:\/\/(www\.)?fil\.one\/?$/.test(url))).toBe(false);

  const cookies = await context.cookies();
  for (const name of AUTH_COOKIES) {
    expect(
      cookies.find((c) => c.name === name),
      `${name} should be cleared`,
    ).toBeUndefined();
  }

  // Server-side: a protected route should bounce to sign-in.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/login/);

  await context.close();
});
