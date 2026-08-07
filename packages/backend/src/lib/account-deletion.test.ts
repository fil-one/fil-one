import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
    RagIndexerTable: { name: 'RagIndexerTable' },
    RagVectorBucket: { name: 'rag-vector-bucket' },
  },
}));

const mockDeleteAuth0User = vi.fn();
vi.mock('./auth0-management.js', () => ({
  deleteAuth0User: (sub: string) => mockDeleteAuth0User(sub),
}));

const mockGetRegionsWithTenantIdsForOrg = vi.fn();
vi.mock('./region-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./region-helpers.js')>()),
  getRegionsWithTenantIdsForOrg: (...args: unknown[]) => mockGetRegionsWithTenantIdsForOrg(...args),
}));

const mockDeleteTenant = vi.fn();
const testOrchestrator = {
  id: 'aurora',
  deleteTenant: (...args: unknown[]) => mockDeleteTenant(...args),
};
vi.mock('./service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: () => testOrchestrator,
  getAvailableOrchestrators: () => [testOrchestrator],
}));

const mockSubscriptionsCancel = vi.fn();
const mockSubscriptionsList = vi.fn();
const mockCustomersSearch = vi.fn();
const mockRawRequest = vi.fn();
vi.mock('./stripe-client.js', () => ({
  getStripeClient: () => ({
    subscriptions: {
      cancel: mockSubscriptionsCancel,
      list: (...args: unknown[]) => mockSubscriptionsList(...args),
    },
    customers: { search: (...args: unknown[]) => mockCustomersSearch(...args) },
    rawRequest: (...args: unknown[]) => mockRawRequest(...args),
  }),
}));

/** Stripe's auto-paginating list result, as the SDK returns it to `for await`. */
function stripeList(subscriptions: { id: string; status: string }[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* subscriptions;
    },
  };
}

/** The same shape for `customers.search`, which teardown discovers through. */
function stripeSearch(hits: { id: string; metadata?: Record<string, string> }[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* hits;
    },
  };
}

/** A Stripe customer hit carrying the metadata both creation paths stamp. */
function customerHit(id: string, orgId: string = ORG_ID) {
  return { id, metadata: { userId: 'user-1', orgId } };
}

const mockGetOrgProfile = vi.fn();
vi.mock('./org-profile.js', () => ({
  getOrgProfile: (orgId: string) => mockGetOrgProfile(orgId),
}));

const mockDropIndex = vi.fn();
vi.mock('@filone/rag-shared', () => ({
  S3VectorsStore: class {
    dropIndex(...args: unknown[]) {
      return mockDropIndex(...args);
    }
  },
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.FILONE_STAGE = 'test';

import {
  assertPurgeablePk,
  batchDelete,
  runAccountDeletion,
  PURGEABLE_BILLING_PK_PREFIXES,
  PURGEABLE_USER_INFO_PK_PREFIXES,
} from './account-deletion.js';
import { OrgDeletionStatus } from './dynamo-records.js';

const ORG_ID = 'org-1';

function deletionItem(status: string, overrides?: Record<string, unknown>) {
  const item: Record<string, unknown> = {
    pk: `ORG#${ORG_ID}`,
    sk: 'DELETION',
    status,
    requestedAt: '2026-07-10T00:00:00.000Z',
    requestedByUserId: 'user-1',
    members: [{ userId: 'user-1', sub: 'auth0|sub-1' }],
    tenantIds: { aurora: 'aurora-t-1' },
    attemptCount: 0,
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
  // An `undefined` override means "absent from the record".
  for (const key of Object.keys(item)) {
    if (item[key] === undefined) delete item[key];
  }
  return marshall(item);
}

function setupHappyMocks(status: string) {
  ddbMock.reset();
  ddbMock
    .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
    .resolves({ Item: deletionItem(status) });
  // No tombstone yet — the mismatch guard reads it before every write.
  ddbMock
    .on(GetItemCommand, { Key: { pk: { S: `ORG_TOMBSTONE#${ORG_ID}` }, sk: { S: 'TOMBSTONE' } } })
    .resolves({});
  ddbMock.on(UpdateItemCommand).resolves({});
  ddbMock.on(DeleteItemCommand).resolves({});
  ddbMock.on(BatchWriteItemCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(ScanCommand).resolves({ Items: [] });
  mockGetOrgProfile.mockResolvedValue({
    pk: { S: `ORG#${ORG_ID}` },
    sk: { S: 'PROFILE' },
    auroraTenantId: { S: 'aurora-t-1' },
  });
  mockGetRegionsWithTenantIdsForOrg.mockResolvedValue([]);
  mockDeleteAuth0User.mockResolvedValue(undefined);
  mockSubscriptionsCancel.mockResolvedValue({});
  mockSubscriptionsList.mockImplementation(({ customer }: { customer: string }) =>
    stripeList([{ id: `sub_${customer.slice('cus_'.length)}`, status: 'active' }]),
  );
  // The org's single Stripe customer, as live metadata search reports it.
  mockCustomersSearch.mockReturnValue(stripeSearch([customerHit('cus_1')]));
  mockDropIndex.mockResolvedValue(undefined);
  mockDeleteTenant.mockResolvedValue(undefined);
  stubRedactionJob();
}

/** Happy-path Redaction Jobs API — the full lifecycle lives in stripe-redaction.test.ts. */
function stubRedactionJob() {
  mockRawRequest.mockImplementation((method: string, path: string) => {
    if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
      return Promise.resolve({ id: 'prj_1', status: 'created' });
    }
    if (method === 'GET') return Promise.resolve({ id: 'prj_1', status: 'ready' });
    return Promise.resolve({ id: 'prj_1' });
  });
}

/** UpdateItem calls that write the terminal DONE status. */
function doneWrites() {
  return ddbMock
    .commandCalls(UpdateItemCommand)
    .filter((c) => c.args[0].input.ExpressionAttributeValues?.[':done']?.S === 'DONE');
}

describe('assertPurgeablePk (purge blast-radius guard)', () => {
  it('refuses to delete the EMAIL_NORM# trial-claim record, which must survive account deletion (FIL-422)', () => {
    expect(() =>
      assertPurgeablePk('EMAIL_NORM#user@gmail.com', PURGEABLE_USER_INFO_PK_PREFIXES),
    ).toThrow(/outside the purgeable prefixes/);
  });

  it('permits deletion of keys under an allowlisted prefix', () => {
    for (const pk of ['ORG#abc', 'USER#u-1', 'SUB#auth0|x', 'RAGKEYHASH#deadbeef']) {
      expect(() => assertPurgeablePk(pk, PURGEABLE_USER_INFO_PK_PREFIXES)).not.toThrow();
    }
  });

  it('is not fooled by prefix collisions: ORGANIZATION# is not ORG#', () => {
    // The prefixes end in '#' precisely so a longer key family sharing the
    // leading letters can never slip through the guard.
    expect(() => assertPurgeablePk('ORGANIZATION#abc', PURGEABLE_USER_INFO_PK_PREFIXES)).toThrow(
      /outside the purgeable prefixes/,
    );
  });

  it('billing allowlist: permits CUSTOMER# and DELETION_CHALLENGE# rows only', () => {
    expect(() => assertPurgeablePk('CUSTOMER#u-1', PURGEABLE_BILLING_PK_PREFIXES)).not.toThrow();
    expect(() =>
      assertPurgeablePk('DELETION_CHALLENGE#org-1', PURGEABLE_BILLING_PK_PREFIXES),
    ).not.toThrow();
  });

  it('billing allowlist: refuses EMAIL_NORM# (trial claims) and ORG# tombstones, which must outlive the account', () => {
    expect(() =>
      assertPurgeablePk('EMAIL_NORM#user@gmail.com', PURGEABLE_BILLING_PK_PREFIXES),
    ).toThrow(/outside the purgeable prefixes/);
    expect(() => assertPurgeablePk('ORG_TOMBSTONE#org-1', PURGEABLE_BILLING_PK_PREFIXES)).toThrow(
      /outside the purgeable prefixes/,
    );
    expect(() => assertPurgeablePk('ORG#org-1', PURGEABLE_BILLING_PK_PREFIXES)).toThrow(
      /outside the purgeable prefixes/,
    );
  });
});

describe('batchDelete', () => {
  const KEY = { pk: 'ORG#org-1', sk: 'MEMBER#user-1' };
  const unprocessed = {
    UnprocessedItems: { TestTable: [{ DeleteRequest: { Key: marshall(KEY) } }] },
  };

  beforeEach(() => {
    ddbMock.reset();
  });

  it('retries UnprocessedItems with backoff instead of looping tight: two sends, second retries only the leftovers', async () => {
    ddbMock.on(BatchWriteItemCommand).resolvesOnce(unprocessed).resolves({});

    await batchDelete('TestTable', [{ pk: 'ORG#org-1', sk: 'PROFILE' }, KEY], {
      retries: 4,
      minTimeout: 0,
    });

    const sends = ddbMock.commandCalls(BatchWriteItemCommand);
    expect(sends).toHaveLength(2);
    expect(sends[0].args[0].input.RequestItems!.TestTable).toHaveLength(2);
    // Only the unprocessed key is retried, not the whole chunk.
    expect(sends[1].args[0].input.RequestItems!.TestTable).toHaveLength(1);
    expect(sends[1].args[0].input.RequestItems!.TestTable[0].DeleteRequest!.Key!.sk.S).toBe(KEY.sk);
  });

  it('caps the retries and throws on exhaustion so the reconciler re-drives', async () => {
    ddbMock.on(BatchWriteItemCommand).resolves(unprocessed);

    await expect(batchDelete('TestTable', [KEY], { retries: 2, minTimeout: 0 })).rejects.toThrow(
      /unprocessed delete/,
    );

    // 1 initial attempt + 2 retries.
    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(3);
  });
});

describe('runAccountDeletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op without a deletion record', async () => {
    ddbMock.reset();
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    await runAccountDeletion(ORG_ID);

    expect(mockDeleteTenant).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('is a no-op when already DONE: a re-invocation runs no externals', async () => {
    setupHappyMocks(OrgDeletionStatus.Done);

    await runAccountDeletion(ORG_ID);

    expect(mockDeleteTenant).not.toHaveBeenCalled();
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    expect(mockDeleteAuth0User).not.toHaveBeenCalled();
    // Not even an attemptCount bump.
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('runs every external teardown, purges the records, and marks DONE', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock.on(QueryCommand).resolves({
      // purgeRecords org partition query — includes an ACCESSKEY# row, whose
      // upstream key died with the tenant (no per-key revocation anymore).
      Items: [
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'PROFILE' }),
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'MEMBER#user-1' }),
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'ACCESSKEY#key-1' }),
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'DELETION' }),
      ],
    });

    await runAccountDeletion(ORG_ID);

    // All four externals ran.
    expect(mockDeleteTenant).toHaveBeenCalledWith('aurora-t-1');
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_1');
    expect(mockDeleteAuth0User).toHaveBeenCalledWith('auth0|sub-1');
    expect(ddbMock.commandCalls(ScanCommand).length).toBeGreaterThan(0); // RAG purge

    // Tombstone written to BillingTable without PII and without a ttl — once
    // per Stripe pass (the post-purge pass re-writes the same singleton id).
    const puts = ddbMock.commandCalls(PutItemCommand);
    expect(puts).toHaveLength(2);
    const tombstone = puts[0].args[0].input.Item!;
    expect(tombstone.pk.S).toBe(`ORG_TOMBSTONE#${ORG_ID}`);
    expect(tombstone.stripeCustomerId?.S).toBe('cus_1');
    expect(tombstone.ttl).toBeUndefined();
    // The plural snapshot field is gone: the relationship is 1:1 by domain.
    expect(tombstone.stripeCustomerIds).toBeUndefined();
    expect(Object.keys(tombstone)).not.toContain('members');

    // Redaction handed the discovered customer to lib/stripe-redaction.ts,
    // whose job lifecycle is covered by its own suite.
    expect(mockRawRequest).toHaveBeenCalledWith('POST', '/v1/privacy/redaction_jobs', {
      objects: { customers: ['cus_1'] },
    });

    // attemptCount bumped for the reconciler's stuck gauge.
    const bumps = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((c) => c.args[0].input.UpdateExpression?.includes('attemptCount'));
    expect(bumps).toHaveLength(1);

    // Org rows purged (ACCESSKEY# included); the DELETION row itself never is.
    const batchedKeys = ddbMock
      .commandCalls(BatchWriteItemCommand)
      .flatMap((c) => Object.values(c.args[0].input.RequestItems!))
      .flat()
      .map((r) => r.DeleteRequest!.Key!.sk.S);
    expect(batchedKeys).toContain('ACCESSKEY#key-1');
    expect(batchedKeys).not.toContain('DELETION');

    // SUB# row is stripped, not deleted. (The fence re-application also
    // touches SUB#, so filter to the purge's attribute-stripping write.)
    const subUpdates = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter(
        (c) =>
          c.args[0].input.Key?.pk?.S === 'SUB#auth0|sub-1' &&
          c.args[0].input.UpdateExpression?.includes('REMOVE'),
      );
    expect(subUpdates).toHaveLength(1);
    expect(subUpdates[0].args[0].input.UpdateExpression).toContain('REMOVE userId, orgId');

    // Terminal DONE write keeps the members audit trail intact.
    const finals = doneWrites();
    expect(finals).toHaveLength(1);
    expect(finals[0].args[0].input.UpdateExpression).not.toContain('members');
  });

  it('partial failure: the other externals still run, the error propagates, and the record stays non-DONE', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockSubscriptionsCancel.mockRejectedValue(new Error('stripe is down'));

    await expect(runAccountDeletion(ORG_ID)).rejects.toThrow(/Account teardown failed .* stripe/);

    // Concurrent siblings were not aborted by the Stripe failure.
    expect(mockDeleteTenant).toHaveBeenCalledWith('aurora-t-1');
    expect(mockDeleteAuth0User).toHaveBeenCalledWith('auth0|sub-1');
    expect(ddbMock.commandCalls(ScanCommand).length).toBeGreaterThan(0);

    // The purge and the terminal status write never happened.
    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(0);
    expect(doneWrites()).toHaveLength(0);

    // The next run re-executes everything and completes.
    mockSubscriptionsCancel.mockResolvedValue({});
    await runAccountDeletion(ORG_ID);

    expect(mockDeleteTenant).toHaveBeenCalledTimes(2);
    expect(mockDeleteAuth0User).toHaveBeenCalledTimes(2);
    expect(doneWrites()).toHaveLength(1);
  });

  it('a record persisted with a legacy intermediate status still completes', async () => {
    // Written by the retired step state machine; anything non-DONE means
    // "in progress → run everything".
    setupHappyMocks('STRIPE_CANCELED');

    await runAccountDeletion(ORG_ID);

    expect(mockDeleteTenant).toHaveBeenCalledWith('aurora-t-1');
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_1');
    expect(mockDeleteAuth0User).toHaveBeenCalledWith('auth0|sub-1');
    expect(doneWrites()).toHaveLength(1);
  });

  it('re-applies the deletion fences at teardown start (confirm handler may have crashed before writing them)', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);

    await runAccountDeletion(ORG_ID);

    const updates = ddbMock.commandCalls(UpdateItemCommand).map((c) => c.args[0].input);
    // Org profile tenant-setup fence.
    expect(
      updates.some(
        (u) =>
          u.Key?.pk?.S === `ORG#${ORG_ID}` &&
          u.Key?.sk?.S === 'PROFILE' &&
          u.UpdateExpression === 'SET deleting = :true',
      ),
    ).toBe(true);
    // Billing-webhook fence for the snapshotted member.
    expect(
      updates.some(
        (u) =>
          u.Key?.pk?.S === 'CUSTOMER#user-1' &&
          u.UpdateExpression === 'SET deletionRequestedAt = :now',
      ),
    ).toBe(true);
    // SUB# session-kill tombstone.
    expect(
      updates.some(
        (u) =>
          u.Key?.pk?.S === 'SUB#auth0|sub-1' &&
          u.UpdateExpression === 'SET deleted = :true, deletedAt = if_not_exists(deletedAt, :now)',
      ),
    ).toBe(true);
  });

  it('tolerates already-purged profile and billing rows when re-applying the fences', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    // A later pass: the profile and billing rows are gone, so the guarded
    // conditional writes fail their attribute_exists conditions.
    const conditionFailure = new ConditionalCheckFailedException({
      message: 'gone',
      $metadata: {},
    });
    ddbMock
      .on(UpdateItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } } })
      .rejects(conditionFailure);
    ddbMock
      .on(UpdateItemCommand, { Key: { pk: { S: 'CUSTOMER#user-1' }, sk: { S: 'SUBSCRIPTION' } } })
      .rejects(conditionFailure);

    await runAccountDeletion(ORG_ID);

    expect(doneWrites()).toHaveLength(1);
  });

  it('touches updatedAt on every attemptCount bump so a live worker never looks stale to the reconciler', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);

    await runAccountDeletion(ORG_ID);

    const bumps = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((c) => c.args[0].input.UpdateExpression?.includes('attemptCount'));
    expect(bumps).toHaveLength(1);
    expect(bumps[0].args[0].input.UpdateExpression).toContain('SET updatedAt = :now');
    expect(bumps[0].args[0].input.ExpressionAttributeValues?.[':now']?.S).toBeDefined();
  });

  it('skips redaction when discovery finds no Stripe customer', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockCustomersSearch.mockReturnValue(stripeSearch([]));

    await runAccountDeletion(ORG_ID);

    expect(mockRawRequest).not.toHaveBeenCalled();
    expect(mockSubscriptionsList).not.toHaveBeenCalled();
    expect(doneWrites()).toHaveLength(1);
  });

  it('cancels subscriptions Stripe reports live, including ones created after the snapshot', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockSubscriptionsList.mockReturnValue(
      stripeList([
        { id: 'sub_1', status: 'active' },
        { id: 'sub_late', status: 'trialing' },
        { id: 'sub_gone', status: 'canceled' },
        { id: 'sub_dead', status: 'incomplete_expired' },
      ]),
    );

    await runAccountDeletion(ORG_ID);

    expect(mockSubscriptionsList).toHaveBeenCalledWith({
      customer: 'cus_1',
      status: 'all',
      limit: 100,
    });
    // Both Stripe passes sweep, so each live subscription is cancelled twice
    // (idempotent — the second cancel is an already-canceled no-op in Stripe).
    expect(mockSubscriptionsCancel.mock.calls.flat()).toEqual([
      'sub_1',
      'sub_late',
      'sub_1',
      'sub_late',
    ]);
  });

  it('treats a deleted Stripe customer as nothing to cancel (customer.deleted trigger)', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockSubscriptionsList.mockImplementation(() => {
      throw Object.assign(new Error('No such customer'), { code: 'resource_missing' });
    });

    await runAccountDeletion(ORG_ID);

    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    expect(doneWrites()).toHaveLength(1);
  });

  it('propagates a non-resource_missing subscriptions.list failure', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockSubscriptionsList.mockImplementation(() => {
      throw new Error('stripe is down');
    });

    const err = (await runAccountDeletion(ORG_ID).catch((e: unknown) => e)) as AggregateError;
    expect(err).toBeInstanceOf(AggregateError);
    expect(doneWrites()).toHaveLength(0);
  });

  it('treats already-canceled Stripe subscriptions as success', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockSubscriptionsCancel.mockRejectedValue(
      Object.assign(new Error('No such subscription'), { code: 'resource_missing' }),
    );

    await runAccountDeletion(ORG_ID);

    expect(doneWrites()).toHaveLength(1);
  });

  it("treats Stripe's invalid_request_error for an already-canceled subscription as success", async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockSubscriptionsCancel.mockRejectedValue(
      Object.assign(
        new Error("This subscription can't be canceled because it's already canceled."),
        { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error' },
      ),
    );

    await runAccountDeletion(ORG_ID);

    expect(doneWrites()).toHaveLength(1);
  });

  it('propagates a transport-level "request was canceled" error instead of reading it as cancel-success', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    // No Stripe error type/code — e.g. an aborted fetch. /canceled/i message
    // sniffing used to swallow this and skip the cancellation forever.
    mockSubscriptionsCancel.mockRejectedValue(new Error('The request was canceled'));

    const err = (await runAccountDeletion(ORG_ID).catch((e: unknown) => e)) as AggregateError;
    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors.map(String).join('\n')).toMatch(/request was canceled/);
    expect(doneWrites()).toHaveLength(0);
  });

  it('tears down a half-provisioned tenant: tenantId on the profile but setup incomplete', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    // Mid-setup profile: the tenant id attribute exists but the setup status
    // never reached completion — isTenantReady would return null for this,
    // yet the tenant already exists upstream and must still be deleted.
    mockGetOrgProfile.mockResolvedValue({
      pk: { S: `ORG#${ORG_ID}` },
      sk: { S: 'PROFILE' },
      auroraTenantId: { S: 'half-provisioned-t' },
      auroraSetupStatus: { S: 'AURORA_TENANT_CREATED' },
    });

    await runAccountDeletion(ORG_ID);

    expect(mockDeleteTenant).toHaveBeenCalledWith('half-provisioned-t');
    expect(doneWrites()).toHaveLength(1);
  });

  it('snapshots late-provisioned tenants onto the DELETION record and deletes them before purging', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    const lateDeleteTenant = vi.fn().mockResolvedValue(undefined);
    mockGetRegionsWithTenantIdsForOrg.mockResolvedValue([
      { orchestrator: { id: 'aurora', deleteTenant: lateDeleteTenant }, tenantId: 'late-tenant' },
    ]);

    await runAccountDeletion(ORG_ID);

    // Live tenant ids persisted onto the DELETION record BEFORE the ORG#
    // partition purge kills the profile row (the only other pointer to them).
    const tenantIdWrites = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((c) => c.args[0].input.UpdateExpression?.includes('tenantIds'));
    expect(tenantIdWrites).toHaveLength(1);
    const written = unmarshall(tenantIdWrites[0].args[0].input.ExpressionAttributeValues!);
    expect(written[':tenantIds']).toMatchObject({ aurora: 'late-tenant' });

    // And the straggler tenant was torn down.
    expect(lateDeleteTenant).toHaveBeenCalledWith('late-tenant');
  });

  it('falls back to the DELETION-record snapshot when the profile row is already purged', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockGetOrgProfile.mockResolvedValue(undefined);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
      .resolves({
        Item: deletionItem(OrgDeletionStatus.Pending, { tenantIds: { aurora: 'snap-t-9' } }),
      });

    await runAccountDeletion(ORG_ID);

    expect(mockDeleteTenant).toHaveBeenCalledWith('snap-t-9');
  });

  it('purges the RAGKEYHASH lookup rows (credential-hash residue) before the ORG# partition delete', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    // The RAGKEY#-prefixed query purgeRagKeyHashRows issues.
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: marshall({ ':pk': `ORG#${ORG_ID}`, ':skPrefix': 'RAGKEY#' }),
      })
      .resolves({
        Items: [
          marshall({ pk: `ORG#${ORG_ID}`, sk: 'RAGKEY#key-1', tokenHash: 'hash-1' }),
          marshall({ pk: `ORG#${ORG_ID}`, sk: 'RAGKEY#key-2', tokenHash: 'hash-2' }),
        ],
      });

    await runAccountDeletion(ORG_ID);

    const userInfoDeletes = ddbMock
      .commandCalls(BatchWriteItemCommand)
      .flatMap((c) => c.args[0].input.RequestItems?.UserInfoTable ?? [])
      .map((r) => unmarshall(r.DeleteRequest!.Key!));
    expect(userInfoDeletes).toContainEqual({ pk: 'RAGKEYHASH#hash-1', sk: 'LOOKUP' });
    expect(userInfoDeletes).toContainEqual({ pk: 'RAGKEYHASH#hash-2', sk: 'LOOKUP' });
    expect(doneWrites()).toHaveLength(1);
  });

  it('purges all RAG rows (bucket + checkpoint prefixes) with a single table scan', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        marshall({ pk: `BUCKET#${ORG_ID}#eu-west-1#my-bucket`, sk: 'RAG' }),
        marshall({ pk: `BUCKET#${ORG_ID}#eu-west-1#my-bucket`, sk: 'MANIFEST#a.txt' }),
        marshall({ pk: `INDEXER_CHECKPOINT#${ORG_ID}#eu-west-1#my-bucket`, sk: 'CHECKPOINT' }),
      ],
    });

    await runAccountDeletion(ORG_ID);

    // ONE scan pass covering both prefixes, not one full scan per prefix.
    const scans = ddbMock.commandCalls(ScanCommand);
    expect(scans).toHaveLength(1);
    expect(scans[0].args[0].input.FilterExpression).toBe(
      'begins_with(pk, :bucketPrefix) OR begins_with(pk, :checkpointPrefix)',
    );
    expect(unmarshall(scans[0].args[0].input.ExpressionAttributeValues!)).toEqual({
      ':bucketPrefix': `BUCKET#${ORG_ID}#`,
      ':checkpointPrefix': `INDEXER_CHECKPOINT#${ORG_ID}#`,
    });

    // The vector index is dropped once per bucket, and every row (manifests
    // and the checkpoint alike) is batch-deleted.
    expect(mockDropIndex).toHaveBeenCalledTimes(1);
    expect(mockDropIndex).toHaveBeenCalledWith(ORG_ID, 'eu-west-1', 'my-bucket');
    const ragDeletes = ddbMock
      .commandCalls(BatchWriteItemCommand)
      .flatMap((c) => c.args[0].input.RequestItems?.RagIndexerTable ?? [])
      .map((r) => r.DeleteRequest!.Key!.pk.S);
    expect(ragDeletes).toEqual([
      `BUCKET#${ORG_ID}#eu-west-1#my-bucket`,
      `BUCKET#${ORG_ID}#eu-west-1#my-bucket`,
      `INDEXER_CHECKPOINT#${ORG_ID}#eu-west-1#my-bucket`,
    ]);
  });

  it('pages the RAG scan and tolerates NotFound index drops on re-run', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [marshall({ pk: `BUCKET#${ORG_ID}#eu-west-1#my-bucket`, sk: 'RAG' })],
        LastEvaluatedKey: marshall({ pk: 'x', sk: 'y' }),
      })
      .resolves({
        Items: [marshall({ pk: `BUCKET#${ORG_ID}#eu-west-1#my-bucket`, sk: 'MANIFEST#a.txt' })],
      });
    mockDropIndex.mockRejectedValue(
      Object.assign(new Error('gone'), { name: 'NotFoundException' }),
    );

    await runAccountDeletion(ORG_ID);

    // Paged once via LastEvaluatedKey — still a single scan PASS.
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(mockDropIndex).toHaveBeenCalledWith(ORG_ID, 'eu-west-1', 'my-bucket');
    // NotFound swallowed → the run still completed.
    expect(doneWrites()).toHaveLength(1);
  });
});

describe('runAccountDeletion — live Stripe customer discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** The tombstone writes, newest last. */
  function tombstoneWrites() {
    return ddbMock
      .commandCalls(PutItemCommand)
      .filter((c) => c.args[0].input.Item?.pk?.S === `ORG_TOMBSTONE#${ORG_ID}`);
  }

  it('cancels and redacts a customer that exists ONLY in Stripe — no record field ever held it', async () => {
    // The bug this replaces: a customer minted inside the deletion race window
    // is invisible to any confirm-time snapshot, so its PII survived forever.
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockCustomersSearch.mockReturnValue(stripeSearch([customerHit('cus_racer')]));

    await runAccountDeletion(ORG_ID);

    expect(mockCustomersSearch).toHaveBeenCalledWith({
      query: "metadata['userId']:'user-1'",
      limit: 100,
    });
    expect(mockSubscriptionsList).toHaveBeenCalledWith({
      customer: 'cus_racer',
      status: 'all',
      limit: 100,
    });
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_racer');
    expect(mockRawRequest).toHaveBeenCalledWith('POST', '/v1/privacy/redaction_jobs', {
      objects: { customers: ['cus_racer'] },
    });
    expect(tombstoneWrites()[0].args[0].input.Item!.stripeCustomerId?.S).toBe('cus_racer');
    expect(doneWrites()).toHaveLength(1);
  });

  it('never touches a customer whose metadata names another org', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockCustomersSearch.mockReturnValue(
      stripeSearch([customerHit('cus_foreign', 'org-other'), customerHit('cus_1')]),
    );

    await runAccountDeletion(ORG_ID);

    const sweptCustomers = mockSubscriptionsList.mock.calls.map(
      (args) => (args[0] as { customer: string }).customer,
    );
    expect(sweptCustomers).not.toContain('cus_foreign');
    expect(sweptCustomers).toContain('cus_1');
    expect(mockSubscriptionsCancel.mock.calls.flat()).not.toContain('sub_foreign');
    expect(mockRawRequest).toHaveBeenCalledWith('POST', '/v1/privacy/redaction_jobs', {
      objects: { customers: ['cus_1'] },
    });
  });

  it('fails the run when discovery fails — no snapshot to fall back to, so the record stays non-DONE', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockCustomersSearch.mockImplementation(() => {
      throw new Error('stripe search is down');
    });

    const err = (await runAccountDeletion(ORG_ID).catch((e: unknown) => e)) as AggregateError;

    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors.map(String).join('\n')).toMatch(/Stripe customer search failed/);
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    expect(doneWrites()).toHaveLength(0);
  });

  it('the post-purge second pass catches a customer the index-lagged first pass could not see', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Stripe Search indexes writes ~25s behind: the first pass sees nothing,
    // the post-purge pass sees the customer minted just before the confirm.
    mockCustomersSearch
      .mockReturnValueOnce(stripeSearch([]))
      .mockReturnValue(stripeSearch([customerHit('cus_late')]));

    await runAccountDeletion(ORG_ID);

    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_late');
    expect(mockRawRequest).toHaveBeenCalledWith('POST', '/v1/privacy/redaction_jobs', {
      objects: { customers: ['cus_late'] },
    });
    // The first pass tombstoned nothing; the second records the late customer.
    const tombstones = tombstoneWrites();
    expect(tombstones[0].args[0].input.Item!.stripeCustomerId).toBeUndefined();
    expect(tombstones[1].args[0].input.Item!.stripeCustomerId?.S).toBe('cus_late');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('minted inside the deletion race window'),
      { orgId: ORG_ID, customerId: 'cus_late' },
    );
    expect(doneWrites()).toHaveLength(1);
    warn.mockRestore();
  });

  it('multiple discovered customers: cancels ALL of them, then refuses to finish', async () => {
    // The org ↔ customer relationship is 1:1 by domain. If it ever breaks,
    // billing must still stop everywhere — but a single-customer tombstone and
    // redaction job cannot represent the extras, so the run must not complete.
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockCustomersSearch.mockReturnValue(stripeSearch([customerHit('cus_1'), customerHit('cus_2')]));

    const err = (await runAccountDeletion(ORG_ID).catch((e: unknown) => e)) as AggregateError;

    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_1');
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_2');
    expect(err.errors.map(String).join('\n')).toMatch(
      /multiple Stripe customers discovered for org org-1 \(cus_1, cus_2\)/,
    );
    // Nothing was tombstoned or redacted — a human picks the survivor.
    expect(tombstoneWrites()).toHaveLength(0);
    expect(mockRawRequest).not.toHaveBeenCalled();
    expect(doneWrites()).toHaveLength(0);
  });

  it('refuses to swap a tombstone that already records a different customer', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG_TOMBSTONE#${ORG_ID}` }, sk: { S: 'TOMBSTONE' } } })
      .resolves({
        Item: marshall({
          pk: `ORG_TOMBSTONE#${ORG_ID}`,
          sk: 'TOMBSTONE',
          orgId: ORG_ID,
          stripeCustomerId: 'cus_old',
          deletedAt: '2026-07-10T00:00:00.000Z',
        }),
      });
    mockCustomersSearch.mockReturnValue(stripeSearch([customerHit('cus_new')]));

    const err = (await runAccountDeletion(ORG_ID).catch((e: unknown) => e)) as AggregateError;

    expect(err.errors.map(String).join('\n')).toMatch(
      /tombstone already records Stripe customer cus_old but discovery found cus_new/,
    );
    // The old pointer survives — overwriting it would strand cus_old
    // unredactable.
    expect(tombstoneWrites()).toHaveLength(0);
    expect(doneWrites()).toHaveLength(0);
  });
});
