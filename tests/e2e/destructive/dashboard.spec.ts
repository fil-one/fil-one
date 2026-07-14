import { test, expect } from '@playwright/test';
import { STORAGE_STATE } from './roles.util.ts';

// Convention: one spec per feature, one describe block per role. Each test name
// starts with the role being exercised so reports read clearly in CI.

test.describe('paid user', () => {
  test.use({ storageState: STORAGE_STATE.paid });

  test('paid user sees full dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('#dashboard-heading')).toBeVisible();
    await expect(page.getByTestId('subscription-status')).toHaveAttribute('data-status', 'active');
    await expect(page.locator('#sidebar-upgrade-button')).not.toBeVisible();
  });
});

test.describe('unpaid user', () => {
  test.use({ storageState: STORAGE_STATE.unpaid });

  test('unpaid (past_due) user sees update payment prompt', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('#dashboard-heading')).toBeVisible();
    await expect(page.getByTestId('subscription-status')).toHaveAttribute(
      'data-status',
      'past_due',
    );
    await expect(page.locator('#sidebar-update-payment-button')).toBeVisible();
  });
});

test.describe('trial user', () => {
  test.use({ storageState: STORAGE_STATE.trial });

  test('trial user sees trial-days-remaining badge', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('#dashboard-heading')).toBeVisible();
    await expect(page.locator('#sidebar-upgrade-button')).toBeVisible();
    await expect(page.getByTestId('subscription-status')).toHaveAttribute(
      'data-status',
      'trialing',
    );
  });
});
