import { test, expect, api } from './fixtures.ts';
import { homeOrgOf, imageHost, resetLogoUploadRate, resetToHomeOrg, userIdOf } from './org.util.ts';
import { STORAGE_STATE, USERS } from './users.util.ts';

const FOREIGN_IMAGE = 'https://images.example.com/picture.png';

test.use({ storageState: STORAGE_STATE.owner });

let orgId: string;

test.beforeAll(async () => {
  const ownerId = await userIdOf('owner');
  await resetToHomeOrg(ownerId);
  orgId = await homeOrgOf(ownerId);
  await resetLogoUploadRate(orgId);
});

test.afterAll(async () => {
  await resetLogoUploadRate(orgId);
});

test('an org logo off our bucket is refused', async ({ page }) => {
  const response = await api(page, 'PATCH', '/api/org', { logoUrl: FOREIGN_IMAGE });
  expect({ status: response.status(), ...(await response.json()) }).toMatchObject({
    status: 400,
    message: 'logoUrl must be a URL returned by the logo upload endpoint',
  });
});

test('a profile picture off our bucket is refused', async ({ page }) => {
  const response = await api(page, 'PATCH', '/api/me/profile', { pictureUrl: FOREIGN_IMAGE });
  expect({ status: response.status(), ...(await response.json()) }).toMatchObject({
    status: 400,
    message: 'pictureUrl must be a URL returned by the avatar upload endpoint',
  });
});

test('/me names no image off our bucket', async ({ browser }) => {
  const offHost: string[] = [];
  for (const user of USERS) {
    const page = await browser.newPage({
      storageState: STORAGE_STATE[user],
      ignoreHTTPSErrors: true,
    });
    const me = await (await api(page, 'GET', '/api/me')).json();
    await page.close();
    const urls = [
      me.picture,
      me.logoUrl,
      ...(me.memberships ?? []).map((m: { logoUrl?: string }) => m.logoUrl),
    ];
    offHost.push(...urls.filter((url) => url && new URL(url).hostname !== imageHost()));
  }
  expect(offHost).toEqual([]);
});

test('the 31st logo upload URL within an hour is refused', async ({ page }) => {
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) {
    const response = await api(page, 'POST', '/api/org/logo-upload-url', {
      contentType: 'image/png',
    });
    statuses.push(response.status());
  }
  expect(statuses).toEqual([...Array(30).fill(200), 429]);
});
