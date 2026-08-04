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
vi.mock('./stripe-client.js', () => ({
  getStripeClient: () => ({ subscriptions: { cancel: mockSubscriptionsCancel } }),
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

import { assertPurgeAllowed, runAccountDeletion } from './account-deletion.js';
import { OrgDeletionStatus } from './dynamo-records.js';

const ORG_ID = 'org-1';

function deletionItem(status: string, overrides?: Record<string, unknown>) {
  return marshall({
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
  });
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
}

/** UpdateItem calls that write the terminal DONE status. */
function doneWrites() {
  return ddbMock
    .commandCalls(UpdateItemCommand)
    .filter((c) => c.args[0].input.ExpressionAttributeValues?.[':done']?.S === 'DONE');
}

describe('assertPurgeAllowed', () => {
  it('throws for the FIL-422 trial-claim prefix', () => {
    expect(() =>
      assertPurgeAllowed('EMAIL_NORM#user@gmail.com', ['ORG#', 'USER#', 'SUB#']),
    ).toThrow(/outside the allowlist/);
  });

  it('allows org-prefixed keys', () => {
    expect(() => assertPurgeAllowed('ORG#abc', ['ORG#', 'USER#', 'SUB#'])).not.toThrow();
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

  it('drops vector indexes for RAG rows and tolerates NotFound on re-run', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          marshall({ pk: `BUCKET#${ORG_ID}#eu-west-1#my-bucket`, sk: 'RAG' }),
          marshall({ pk: `BUCKET#${ORG_ID}#eu-west-1#my-bucket`, sk: 'MANIFEST#a.txt' }),
        ],
      })
      .resolves({ Items: [] });
    mockDropIndex.mockRejectedValue(
      Object.assign(new Error('gone'), { name: 'NotFoundException' }),
    );

    await runAccountDeletion(ORG_ID);

    expect(mockDropIndex).toHaveBeenCalledWith(ORG_ID, 'eu-west-1', 'my-bucket');
    // NotFound swallowed → the run still completed.
    expect(doneWrites()).toHaveLength(1);
  });
});
