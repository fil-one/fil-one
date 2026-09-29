import { expect, type Page } from '@playwright/test';

export const USERS = ['owner', 'member', 'fresh'] as const;
export type OrgUser = (typeof USERS)[number];

export const STORAGE_STATE: Record<OrgUser, string> = {
  owner: '.auth/org-owner.json',
  member: '.auth/org-member.json',
  fresh: '.auth/org-fresh.json',
};

export function credential(user: OrgUser, field: 'EMAIL' | 'PASSWORD' | 'AUTH0_ID'): string {
  const name = `E2E_ORG_${user.toUpperCase()}_${field}`;
  const value = process.env[name];
  if (!value) throw new Error(`Missing required E2E credential env var: ${name}.`);
  return value;
}

/** Where a login can land, depending on the account's state. */
export const LANDED = /\/(dashboard|get-started|create-organization|left-organization)$/;

export async function logIn(page: Page, user: OrgUser): Promise<void> {
  await page.goto('/');
  await page.locator('#username').fill(credential(user, 'EMAIL'));
  await page.locator('button[data-action-button-primary="true"]').click();
  await page.locator('#password').fill(credential(user, 'PASSWORD'));
  await page.locator('button[data-action-button-primary="true"]').click();

  const skipPasskey = page.locator('button[value="abort-passkey-enrollment"]');
  await Promise.race([skipPasskey.waitFor(), page.waitForURL(LANDED)]);
  if (await skipPasskey.isVisible()) await skipPasskey.click();
  await expect(page).toHaveURL(LANDED);
}

/** The org names the switcher lists, in the order it lists them. */
export async function switcherNames(page: Page): Promise<string[]> {
  const rows = page.getByTestId('org-switcher').locator('button');
  // Each row is the avatar's monogram, then the name.
  return (await rows.allInnerTexts()).map((text) => text.trim().split('\n').at(-1)!.trim());
}

/** Open the org menu and switch to `orgName`. */
export async function switchTo(page: Page, orgName: string): Promise<void> {
  await page.getByTestId('org-switcher-button').click();
  await page.getByTestId('org-switcher').locator('button', { hasText: orgName }).click();
  await expect(page.getByTestId('org-switcher-button')).toContainText(orgName);
}

/** A row of the org menu, which carries no ids of its own. */
export function menuItem(page: Page, label: string) {
  return page.locator('[role="menuitem"]', { hasText: label });
}

/** The billing gate, standing in for the page. */
export function billingGate(page: Page) {
  return page.locator('main').filter({ hasText: 'Add a payment method to continue' });
}

/** Names in the order the switcher sorts them. */
export function byName(names: string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}
