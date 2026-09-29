import fs from 'node:fs/promises';
import path from 'node:path';
import { test as setup, expect, api } from './fixtures.ts';
import { homeOrgOf, resetToHomeOrg, setOrgName, userIdOf } from './org.util.ts';
import { grantEmailBeta } from '../destructive/invite.util.ts';
import { STORAGE_STATE, USERS, credential, logIn } from './users.util.ts';

// Every account is in the organizations beta. The owner and the member start
// from a named organization with a trial; the fresh account's naming is what
// naming.spec.ts drives.
const ORG_NAMES = { owner: 'E2E Owner Org', member: 'E2E Member Org' } as const;

for (const user of USERS) {
  setup(`authenticate as ${user}`, async ({ page }) => {
    setup.setTimeout(120_000);
    await grantEmailBeta(credential(user, 'EMAIL'));
    await logIn(page, user);
    if (user !== 'fresh') {
      const userId = await userIdOf(user);
      await resetToHomeOrg(userId);
      await setOrgName(await homeOrgOf(userId), { name: ORG_NAMES[user] });
      // Claims the trial on a new account, as the dashboard would; a no-op after.
      expect((await api(page, 'GET', '/api/billing')).status()).toBe(200);
    }

    await fs.mkdir(path.dirname(STORAGE_STATE[user]), { recursive: true });
    await page.context().storageState({ path: STORAGE_STATE[user] });
  });
}
