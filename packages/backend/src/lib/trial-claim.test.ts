import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { OrgRole } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
  },
}));

vi.mock('./trial-entitlement.ts', () => ({ ensureTrialEntitlement: vi.fn() }));
vi.mock('./org-membership.ts', () => ({ listMemberships: vi.fn() }));

const ddbMock = mockClient(DynamoDBClient);

import { claimTrialIfEligible } from './trial-claim.ts';
import { listMemberships } from './org-membership.ts';
import { ensureTrialEntitlement } from './trial-entitlement.ts';
import type { UserInfo } from './user-context.ts';

const mockEnsureTrialEntitlement = vi.mocked(ensureTrialEntitlement);
const mockListMemberships = vi.mocked(listMemberships);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

function soloOwner(overrides: Partial<UserInfo> = {}): UserInfo {
  return {
    sub: 'auth0|sub-1',
    userId: USER_ID,
    orgId: ORG_ID,
    email: 'user@example.com',
    emailVerified: true,
    membership: { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Owner, source: 'signup' },
    ...overrides,
  } as UserInfo;
}

beforeEach(() => {
  ddbMock.reset();
  vi.clearAllMocks();
  mockListMemberships.mockResolvedValue([{ orgId: ORG_ID, role: OrgRole.Owner, joinedAt: '' }]);
  mockEnsureTrialEntitlement.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('claimTrialIfEligible', () => {
  it('claims for a solo owner in their own org', async () => {
    await expect(claimTrialIfEligible(soloOwner())).resolves.toBe('claimed');
    expect(mockEnsureTrialEntitlement).toHaveBeenCalledOnce();
  });

  it('does not claim under an API key session', async () => {
    await expect(claimTrialIfEligible(soloOwner({ apiKeySession: true }))).resolves.toBe(
      'api-key-session',
    );
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  // An invitation joins somebody else's org. A manual org is one the account
  // created after the fact, or the floor org a removal made.
  it.each(['invitation', 'manual'] as const)(
    'does not claim in a solo org the account joined by %s',
    async (source) => {
      const caller = soloOwner({
        membership: { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Owner, source },
      } as Partial<UserInfo>);

      await expect(claimTrialIfEligible(caller)).resolves.toBe('not-own-org');
      expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
    },
  );

  it('refuses an owner who also holds an org they created', async () => {
    mockListMemberships.mockResolvedValue([
      { orgId: ORG_ID, role: OrgRole.Owner, joinedAt: '' },
      { orgId: 'org-created', role: OrgRole.Owner, joinedAt: '' },
    ]);

    await expect(claimTrialIfEligible(soloOwner())).resolves.toBe('not-own-org');
    expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
  });

  it('reports not-entitled when the claim is already spent', async () => {
    mockEnsureTrialEntitlement.mockResolvedValue(false);

    await expect(claimTrialIfEligible(soloOwner())).resolves.toBe('not-entitled');
  });
});
