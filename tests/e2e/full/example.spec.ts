import { test, expect } from '@playwright/test';

test('homepage loads with a non-empty title', async ({ page }) => {
  await page.goto('/');
  await expect(page).not.toHaveTitle('');
});
