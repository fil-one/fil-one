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
vi.mock('./stripe-webhook-metrics.js', () => ({ emitTrialClaimBlockedByLegacyRow: vi.fn() }));

const ddbMock = mockClient(DynamoDBClient);

import { claimTrialIfEligible } from './trial-claim.js';
import { listMemberships } from './org-membership.js';
import { emitTrialClaimBlockedByLegacyRow } from './stripe-webhook-metrics.js';
import { ensureTrialEntitlement } from './trial-entitlement.js';
import type { UserInfo } from './user-context.js';

const mockEnsureTrialEntitlement = vi.mocked(ensureTrialEntitlement);
const mockListMemberships = vi.mocked(listMemberships);
const mockEmitBlocked = vi.mocked(emitTrialClaimBlockedByLegacyRow);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-1';
const ORG_ID = 'org-1';
const LEGACY_KEY = { pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } };
const ORG_KEY = { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'SUBSCRIPTION' } };

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

  it('refuses before minting anything when the legacy row stands and the org row does not', async () => {
    // The refusal lives here rather than at a call site: every route that can
    // reach this function can reach a second Stripe customer, and the second
    // one is not something a later run can undo.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(GetItemCommand, { Key: LEGACY_KEY }).resolves({ Item: LEGACY_KEY });

    await expect(claimTrialIfEligible(soloOwner())).resolves.toBe('legacy-row');

    expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
    expect(mockEmitBlocked).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it('claims when the org row stands beside the legacy row, the dual-write twin', async () => {
    // The flip gate requires the twin, so a row on both keys is the normal
    // state, not a missed backfill. Refusing it answered 503 on the billing
    // dashboard and the subscription guard for every account that opened and
    // abandoned the payment modal during dual-write.
    ddbMock.on(GetItemCommand, { Key: LEGACY_KEY }).resolves({ Item: LEGACY_KEY });
    ddbMock.on(GetItemCommand, { Key: ORG_KEY }).resolves({ Item: ORG_KEY });

    await expect(claimTrialIfEligible(soloOwner())).resolves.toBe('claimed');

    expect(mockEmitBlocked).not.toHaveBeenCalled();
    expect(mockEnsureTrialEntitlement).toHaveBeenCalledOnce();
  });

  it('reads the org row consistently before refusing', async () => {
    ddbMock.on(GetItemCommand, { Key: LEGACY_KEY }).resolves({ Item: LEGACY_KEY });
    ddbMock.on(GetItemCommand, { Key: ORG_KEY }).resolves({ Item: ORG_KEY });

    await claimTrialIfEligible(soloOwner());

    const orgRead = ddbMock
      .commandCalls(GetItemCommand)
      .map((call) => call.args[0].input)
      .find((input) => input.Key?.pk?.S === `ORG#${ORG_ID}`);
    expect(orgRead?.ConsistentRead).toBe(true);
  });

  it('does not read the org row when no legacy row stands', async () => {
    await claimTrialIfEligible(soloOwner());

    const keys = ddbMock.commandCalls(GetItemCommand).map((call) => call.args[0].input.Key);
    expect(keys).toStrictEqual([LEGACY_KEY]);
  });

  it('answers not-own-org for an invited member whose own org has a legacy row', async () => {
    // The row is keyed by user and the request is about another org, so the
    // legacy refusal is not the answer here: it would return a 503 "billing is
    // unavailable" for a member opening a second org, and inflate the denial
    // rate the runbook's cleanup precondition reads. Nothing can be minted
    // either way — the mint is downstream of the ownership test.
    ddbMock.on(GetItemCommand, { Key: LEGACY_KEY }).resolves({ Item: LEGACY_KEY });
    const invited = soloOwner({
      membership: { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Member, source: 'invitation' },
    } as Partial<UserInfo>);

    await expect(claimTrialIfEligible(invited)).resolves.toBe('not-own-org');

    expect(mockEmitBlocked).not.toHaveBeenCalled();
    expect(mockEnsureTrialEntitlement).not.toHaveBeenCalled();
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
