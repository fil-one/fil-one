import fs from 'node:fs/promises';
import path from 'node:path';
import { test as setup } from './fixtures.ts';
import { homeOrgOf, setOrgName, userIdOf } from './org.util.ts';
import { STORAGE_STATE, USERS, logIn } from './users.util.ts';

// The owner and the member start from a named organization; the fresh account's
// naming is what naming.spec.ts drives.
const ORG_NAMES = { owner: 'E2E Owner Org', member: 'E2E Member Org' } as const;

for (const user of USERS) {
  setup(`authenticate as ${user}`, async ({ page }) => {
    setup.setTimeout(120_000);
    await logIn(page, user);
    if (user !== 'fresh') {
      await setOrgName(await homeOrgOf(await userIdOf(user)), { name: ORG_NAMES[user] });
    }

    await fs.mkdir(path.dirname(STORAGE_STATE[user]), { recursive: true });
    await page.context().storageState({ path: STORAGE_STATE[user] });
  });
}
