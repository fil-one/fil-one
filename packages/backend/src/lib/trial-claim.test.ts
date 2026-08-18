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

vi.mock('./trial-entitlement.js', () => ({ ensureTrialEntitlement: vi.fn() }));
vi.mock('./org-membership.js', () => ({ listMemberships: vi.fn() }));

const ddbMock = mockClient(DynamoDBClient);

import { claimTrialIfEligible } from './trial-claim.js';
import { listMemberships } from './org-membership.js';
import { ensureTrialEntitlement } from './trial-entitlement.js';
import type { UserInfo } from './user-context.js';

const mockEnsureTrialEntitlement = vi.mocked(ensureTrialEntitlement);
const mockListMemberships = vi.mocked(listMemberships);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-1';
const ORG_ID = 'org-1';
const LEGACY_KEY = { pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } };

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
  // No pre-re-key row unless a test says otherwise.
  ddbMock.on(GetItemCommand).resolves({});
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

  it('refuses before minting anything while a pre-re-key CUSTOMER# row stands', async () => {
    // The refusal lives here rather than at a call site: every route that can
    // reach this function can reach a second Stripe customer, and the second
    // one is not something a later run can undo.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(GetItemCommand, { Key: LEGACY_KEY }).resolves({ Item: LEGACY_KEY });

    await expect(claimTrialIfEligible(soloOwner())).resolves.toBe('legacy-row');

    expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
    // Before the eligibility read too, so no caller can reorder its way past it.
    expect(mockListMemberships).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('reads the row consistently, so a claim moments old is not missed', async () => {
    await claimTrialIfEligible(soloOwner());

    const input = ddbMock.commandCalls(GetItemCommand)[0].args[0].input;
    expect(input.Key).toStrictEqual(LEGACY_KEY);
    expect(input.ConsistentRead).toBe(true);
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

  it('reports not-entitled when the claim is already spent', async () => {
    mockEnsureTrialEntitlement.mockResolvedValue(false);

    await expect(claimTrialIfEligible(soloOwner())).resolves.toBe('not-entitled');
  });
});
