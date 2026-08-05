import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchWriteItemCommand,
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

const mockGetProvisionedRegions = vi.fn();
vi.mock('./region-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./region-helpers.js')>()),
  getProvisionedRegions: (...args: unknown[]) => mockGetProvisionedRegions(...args),
}));

const mockIsTenantReady = vi.fn();
const mockDeleteTenant = vi.fn();
const testOrchestrator = {
  id: 'aurora',
  isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  deleteTenant: (...args: unknown[]) => mockDeleteTenant(...args),
};
vi.mock('./service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: () => testOrchestrator,
  getAvailableOrchestrators: () => [testOrchestrator],
}));

const mockSubscriptionsCancel = vi.fn();
const mockRawRequest = vi.fn();
vi.mock('./stripe-client.js', () => ({
  getStripeClient: () => ({
    subscriptions: { cancel: mockSubscriptionsCancel },
    rawRequest: (...args: unknown[]) => mockRawRequest(...args),
  }),
}));

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
  assertPurgeTargetAllowed,
  batchDelete,
  runAccountDeletion,
  BILLING_PURGE_ALLOWLIST,
  USER_INFO_PURGE_ALLOWLIST,
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
    auroraTenantId: 'aurora-t-1',
    stripeCustomerId: 'cus_1',
    subscriptionId: 'sub_1',
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
  mockGetProvisionedRegions.mockResolvedValue([]);
  mockDeleteAuth0User.mockResolvedValue(undefined);
  mockSubscriptionsCancel.mockResolvedValue({});
  mockDropIndex.mockResolvedValue(undefined);
  mockIsTenantReady.mockReturnValue('aurora-t-1');
  mockDeleteTenant.mockResolvedValue(undefined);
  stubRedactionJob();
}

/**
 * Happy-path Redaction Jobs API: create → validate → GET reports `ready` →
 * run. Instant validation, so a single teardown pass completes redaction.
 */
function stubRedactionJob(statusOnGet = 'ready') {
  mockRawRequest.mockImplementation((method: string, path: string) => {
    if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
      return Promise.resolve({ id: 'prj_1', status: 'created' });
    }
    if (method === 'GET') return Promise.resolve({ id: 'prj_1', status: statusOnGet });
    return Promise.resolve({ id: 'prj_1' });
  });
}

function rawRequestCalls() {
  return mockRawRequest.mock.calls.map(([method, path]) => `${method} ${path}`);
}

/** UpdateItem calls that write the terminal DONE status. */
function doneWrites() {
  return ddbMock
    .commandCalls(UpdateItemCommand)
    .filter((c) => c.args[0].input.ExpressionAttributeValues?.[':done']?.S === 'DONE');
}

describe('assertPurgeTargetAllowed (purge blast-radius guard)', () => {
  it('refuses to delete the EMAIL_NORM# trial-claim record, which must survive account deletion (FIL-422)', () => {
    expect(() =>
      assertPurgeTargetAllowed('EMAIL_NORM#user@gmail.com', USER_INFO_PURGE_ALLOWLIST),
    ).toThrow(/outside the allowlist/);
  });

  it('permits deletion of keys under an allowlisted prefix', () => {
    for (const pk of ['ORG#abc', 'USER#u-1', 'SUB#auth0|x', 'RAGKEYHASH#deadbeef']) {
      expect(() => assertPurgeTargetAllowed(pk, USER_INFO_PURGE_ALLOWLIST)).not.toThrow();
    }
  });

  it('is not fooled by prefix collisions: ORGANIZATION# is not ORG#', () => {
    // The allowlist prefixes end in '#' precisely so a longer key family
    // sharing the leading letters can never slip through the guard.
    expect(() => assertPurgeTargetAllowed('ORGANIZATION#abc', USER_INFO_PURGE_ALLOWLIST)).toThrow(
      /outside the allowlist/,
    );
  });

  it('billing allowlist: permits CUSTOMER# and DELETION_CHALLENGE# rows only', () => {
    expect(() => assertPurgeTargetAllowed('CUSTOMER#u-1', BILLING_PURGE_ALLOWLIST)).not.toThrow();
    expect(() =>
      assertPurgeTargetAllowed('DELETION_CHALLENGE#org-1', BILLING_PURGE_ALLOWLIST),
    ).not.toThrow();
  });

  it('billing allowlist: refuses EMAIL_NORM# (trial claims) and ORG# tombstones, which must outlive the account', () => {
    expect(() =>
      assertPurgeTargetAllowed('EMAIL_NORM#user@gmail.com', BILLING_PURGE_ALLOWLIST),
    ).toThrow(/outside the allowlist/);
    expect(() => assertPurgeTargetAllowed('ORG_TOMBSTONE#org-1', BILLING_PURGE_ALLOWLIST)).toThrow(
      /outside the allowlist/,
    );
    expect(() => assertPurgeTargetAllowed('ORG#org-1', BILLING_PURGE_ALLOWLIST)).toThrow(
      /outside the allowlist/,
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

    // Tombstone written to BillingTable without PII and without a ttl.
    const puts = ddbMock.commandCalls(PutItemCommand);
    expect(puts).toHaveLength(1);
    const tombstone = puts[0].args[0].input.Item!;
    expect(tombstone.pk.S).toBe(`ORG_TOMBSTONE#${ORG_ID}`);
    expect(tombstone.stripeCustomerId?.S).toBe('cus_1');
    expect(tombstone.ttl).toBeUndefined();
    expect(Object.keys(tombstone)).not.toContain('members');

    // Customer PII redacted after the cancel: create → validate → run, with
    // the job id persisted so a retry advances this job rather than minting
    // a duplicate.
    expect(mockRawRequest).toHaveBeenCalledWith('POST', '/v1/privacy/redaction_jobs', {
      objects: { customers: ['cus_1'] },
    });
    expect(rawRequestCalls()).toEqual([
      'POST /v1/privacy/redaction_jobs',
      'POST /v1/privacy/redaction_jobs/prj_1/validate',
      'GET /v1/privacy/redaction_jobs/prj_1',
      'POST /v1/privacy/redaction_jobs/prj_1/run',
    ]);
    const jobIdWrites = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((c) => c.args[0].input.UpdateExpression?.includes('stripeRedactionJobId'));
    expect(jobIdWrites).toHaveLength(1);
    expect(jobIdWrites[0].args[0].input.ExpressionAttributeValues?.[':jobId']?.S).toBe('prj_1');

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

    // SUB# row is stripped, not deleted.
    const subUpdates = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((c) => c.args[0].input.Key?.pk?.S === 'SUB#auth0|sub-1');
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

  it('leaves a not-yet-ready redaction job pending (record stays non-DONE) and advances it on re-entry without re-creating', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    // Validation still running when this pass checks the job.
    stubRedactionJob('validating');

    const err = (await runAccountDeletion(ORG_ID).catch((e: unknown) => e)) as AggregateError;
    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors.map(String).join('\n')).toMatch(/not ready yet/);
    expect(doneWrites()).toHaveLength(0);

    // Re-entry: the record now carries the persisted job id — the job is
    // fetched and run, never re-created.
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
      .resolves({
        Item: deletionItem(OrgDeletionStatus.Pending, { stripeRedactionJobId: 'prj_1' }),
      });
    mockRawRequest.mockClear();
    stubRedactionJob('ready');

    await runAccountDeletion(ORG_ID);

    expect(rawRequestCalls()).toEqual([
      'GET /v1/privacy/redaction_jobs/prj_1',
      'POST /v1/privacy/redaction_jobs/prj_1/run',
    ]);
    expect(doneWrites()).toHaveLength(1);
  });

  it('treats an already redacting/succeeded job as done on re-entry', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
      .resolves({
        Item: deletionItem(OrgDeletionStatus.Pending, { stripeRedactionJobId: 'prj_1' }),
      });
    stubRedactionJob('redacting');

    await runAccountDeletion(ORG_ID);

    expect(rawRequestCalls()).toEqual(['GET /v1/privacy/redaction_jobs/prj_1']);
    expect(doneWrites()).toHaveLength(1);
  });

  it('tolerates a missing or already-redacted customer at job creation', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockRawRequest.mockRejectedValue(
      Object.assign(new Error('No such customer'), { code: 'resource_missing' }),
    );

    await runAccountDeletion(ORG_ID);

    expect(rawRequestCalls()).toEqual(['POST /v1/privacy/redaction_jobs']);
    expect(doneWrites()).toHaveLength(1);
  });

  it('skips redaction when the snapshot has no Stripe customer', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
      .resolves({
        Item: deletionItem(OrgDeletionStatus.Pending, {
          stripeCustomerId: undefined,
          subscriptionId: undefined,
        }),
      });

    await runAccountDeletion(ORG_ID);

    expect(mockRawRequest).not.toHaveBeenCalled();
    expect(doneWrites()).toHaveLength(1);
  });

  it('surfaces a failed redaction job so the stuck gauge catches it', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
      .resolves({
        Item: deletionItem(OrgDeletionStatus.Pending, { stripeRedactionJobId: 'prj_1' }),
      });
    stubRedactionJob('failed');

    const err = (await runAccountDeletion(ORG_ID).catch((e: unknown) => e)) as AggregateError;
    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors.map(String).join('\n')).toMatch(/unexpected status "failed"/);
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

  it('snapshots late-provisioned tenants onto the DELETION record and deletes them before purging', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    const lateDeleteTenant = vi.fn().mockResolvedValue(undefined);
    mockGetProvisionedRegions.mockResolvedValue([
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

  it('falls back to the legacy per-orchestrator snapshot fields for in-flight records', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockGetOrgProfile.mockResolvedValue(undefined);
    // deletionItem carries legacy auroraTenantId: 'aurora-t-1' and no tenantIds.

    await runAccountDeletion(ORG_ID);

    expect(mockDeleteTenant).toHaveBeenCalledWith('aurora-t-1');
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
