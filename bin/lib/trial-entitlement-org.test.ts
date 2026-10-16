import { describe, expect, it } from 'vitest';
import { SubscriptionStatus } from '@filone/shared';

import { billsTrialTo, isHomeMembership, resolveTrialOrg } from './trial-entitlement-org.ts';

const USER = '0b6f7c1e-2d4a-4f8e-9a1b-3c5d7e9f1a2b';

describe('resolveTrialOrg', () => {
  it('takes the one org billing a trial to the user, over the home org', () => {
    expect(resolveTrialOrg({ billingOrgIds: ['org-a'], homeOrgIds: ['org-b'] })).toEqual({
      orgId: 'org-a',
      via: 'billing',
    });
  });

  it('falls back to the one home org when nothing is billed', () => {
    expect(resolveTrialOrg({ billingOrgIds: [], homeOrgIds: ['org-b'] })).toEqual({
      orgId: 'org-b',
      via: 'home-org',
    });
  });

  it('leaves several or no candidates unresolved', () => {
    expect([
      resolveTrialOrg({ billingOrgIds: ['org-a', 'org-b'], homeOrgIds: ['org-a'] }),
      resolveTrialOrg({ billingOrgIds: [], homeOrgIds: ['org-a', 'org-b'] }),
      resolveTrialOrg({ billingOrgIds: [], homeOrgIds: [] }),
    ]).toEqual([
      { reason: 'billing names several orgs: org-a, org-b' },
      { reason: 'several home orgs: org-a, org-b' },
      { reason: 'no billing row and no home org' },
    ]);
  });
});

describe('billsTrialTo', () => {
  it('counts a trial or subscription owned by the user, not a bare customer mapping or another owner', () => {
    expect([
      billsTrialTo({ userId: USER, subscriptionStatus: SubscriptionStatus.Trialing }, USER),
      billsTrialTo({ userId: USER, subscriptionId: 'sub_1' }, USER),
      billsTrialTo({ userId: USER, stripeCustomerId: 'cus_1' }, USER),
      billsTrialTo({ userId: 'someone-else', subscriptionId: 'sub_1' }, USER),
    ]).toEqual([true, true, false, false]);
  });
});

describe('isHomeMembership', () => {
  it('excludes invited and manually created orgs', () => {
    expect(
      [undefined, 'signup', 'conversion', 'invitation', 'manual'].map((source) =>
        isHomeMembership(source as Parameters<typeof isHomeMembership>[0]),
      ),
    ).toEqual([true, true, true, false, false]);
  });
});
