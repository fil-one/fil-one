import type { Page } from '@playwright/test';
import { LANDED } from '../multi-org/users.util.ts';

export async function maybeSkipPasskeyEnrollment(page: Page): Promise<void> {
  const skipPasskey = page.locator('button[value="abort-passkey-enrollment"]');
  await Promise.race([skipPasskey.waitFor({ state: 'visible' }), page.waitForURL(LANDED)]);
  if (await skipPasskey.isVisible()) {
    await skipPasskey.click();
  }
}
