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

  it('does not claim in somebody else’s org', async () => {
    const invited = soloOwner({
      membership: { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Member, source: 'invitation' },
    } as Partial<UserInfo>);

    await expect(claimTrialIfEligible(invited)).resolves.toBe('not-own-org');
    expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
  });

  it('refuses an owner who also holds an org they created', async () => {
    mockListMemberships.mockResolvedValue([
      { orgId: ORG_ID, role: OrgRole.Owner, joinedAt: '' },
      { orgId: 'org-created', role: OrgRole.Owner, joinedAt: '' },
    ]);

    await expect(claimTrialIfEligible(soloOwner())).resolves.toBe('not-own-org');
    expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
  });

  // Solo in an org they created, or the floor org a removal made: the
  // entitlement decides, and is told the org did not come with the account.
  it('hands the membership source to the entitlement for a solo manual org', async () => {
    const floor = soloOwner({
      membership: { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Owner, source: 'manual' },
    } as Partial<UserInfo>);

    await claimTrialIfEligible(floor);

    expect(mockEnsureTrialEntitlement.mock.calls).toEqual([
      [
        {
          sub: 'auth0|sub-1',
          userId: USER_ID,
          orgId: ORG_ID,
          email: 'user@example.com',
          emailVerified: true,
          membershipSource: 'manual',
        },
      ],
    ]);
  });

  it('reports not-entitled when the claim is already spent', async () => {
    mockEnsureTrialEntitlement.mockResolvedValue(false);

    await expect(claimTrialIfEligible(soloOwner())).resolves.toBe('not-entitled');
  });
});
