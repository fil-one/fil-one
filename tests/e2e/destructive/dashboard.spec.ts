import { test, expect } from '@playwright/test';
import { STORAGE_STATE } from './roles.ts';

// Convention: one spec per feature, one describe block per role. Each test name
// starts with the role being exercised so reports read clearly in CI.

test.describe('paid user', () => {
  test.use({ storageState: STORAGE_STATE.paid });

  test('paid user sees full dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await expect(page.getByText('Active').first()).toBeVisible();
    await expect(
      // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
      page.getByRole('navigation').getByRole('link', { name: 'Upgrade', exact: true }),
    ).not.toBeVisible();
  });
});

test.describe('unpaid user', () => {
  test.use({ storageState: STORAGE_STATE.unpaid });

  test('unpaid (past_due) user sees update payment prompt', async ({ page }) => {
    await page.goto('/dashboard');
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await expect(page.getByText('Past Due')).toBeVisible();
    await expect(
      // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
      page.getByRole('navigation').getByRole('link', { name: 'Update payment', exact: true }),
    ).toBeVisible();
  });
});

test.describe('trial user', () => {
  test.use({ storageState: STORAGE_STATE.trial });

  test('trial user sees trial-days-remaining badge', async ({ page }) => {
    await page.goto('/dashboard');
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(
      // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
      page.getByRole('navigation').getByRole('link', { name: 'Upgrade', exact: true }),
    ).toBeVisible();
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await expect(page.getByText('Free trial').first()).toBeVisible();
  });
});
