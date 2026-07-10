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
import { DeleteParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { marshall } from '@aws-sdk/util-dynamodb';

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

const mockSync = vi.fn();
const mockGetProvisionedRegions = vi.fn();
vi.mock('./region-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./region-helpers.js')>()),
  syncTenantStatusInProvisionedRegions: (...args: unknown[]) => mockSync(...args),
  getProvisionedRegions: (...args: unknown[]) => mockGetProvisionedRegions(...args),
}));

const mockDeleteAccessKey = vi.fn();
const mockIsTenantReady = vi.fn();
vi.mock('./service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: () => ({
    id: 'aurora',
    deleteAccessKey: (...args: unknown[]) => mockDeleteAccessKey(...args),
    isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  }),
  getAvailableOrchestrators: () => [],
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
const ssmMock = mockClient(SSMClient);

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
  ssmMock.reset();
  ddbMock
    .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
    .resolves({ Item: deletionItem(status) });
  ddbMock.on(UpdateItemCommand).resolves({});
  ddbMock.on(DeleteItemCommand).resolves({});
  ddbMock.on(BatchWriteItemCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(ScanCommand).resolves({ Items: [] });
  ssmMock.on(DeleteParameterCommand).resolves({});
  mockGetOrgProfile.mockResolvedValue({
    pk: { S: `ORG#${ORG_ID}` },
    sk: { S: 'PROFILE' },
    auroraTenantId: { S: 'aurora-t-1' },
  });
  mockSync.mockResolvedValue([]);
  mockGetProvisionedRegions.mockResolvedValue([]);
  mockDeleteAuth0User.mockResolvedValue(undefined);
  mockSubscriptionsCancel.mockResolvedValue({});
  mockDropIndex.mockResolvedValue(undefined);
  mockIsTenantReady.mockReturnValue('aurora-t-1');
  mockDeleteAccessKey.mockResolvedValue(undefined);
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

    expect(mockSync).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('is a no-op when already DONE', async () => {
    setupHappyMocks(OrgDeletionStatus.Done);

    await runAccountDeletion(ORG_ID);

    expect(mockSync).not.toHaveBeenCalled();
    // Not even an attemptCount bump.
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('runs the full pipeline from PENDING to DONE', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        // revokeAllAccessKeys: one access key row
        Items: [marshall({ pk: `ORG#${ORG_ID}`, sk: 'ACCESSKEY#key-1', region: 'eu-west-1' })],
      })
      .resolves({
        // purgeRecords org partition query
        Items: [
          marshall({ pk: `ORG#${ORG_ID}`, sk: 'PROFILE' }),
          marshall({ pk: `ORG#${ORG_ID}`, sk: 'MEMBER#user-1' }),
          marshall({ pk: `ORG#${ORG_ID}`, sk: 'DELETION' }),
        ],
      });

    await runAccountDeletion(ORG_ID);

    expect(mockDeleteAccessKey).toHaveBeenCalledWith('aurora-t-1', 'key-1');
    expect(mockSync).toHaveBeenCalledWith(ORG_ID, 'disabled');
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_1');
    expect(mockDeleteAuth0User).toHaveBeenCalledWith('auth0|sub-1');

    // Tombstone written to BillingTable without PII and without a ttl.
    const puts = ddbMock.commandCalls(PutItemCommand);
    expect(puts).toHaveLength(1);
    const tombstone = puts[0].args[0].input.Item!;
    expect(tombstone.pk.S).toBe(`ORG_TOMBSTONE#${ORG_ID}`);
    expect(tombstone.stripeCustomerId?.S).toBe('cus_1');
    expect(tombstone.ttl).toBeUndefined();
    expect(Object.keys(tombstone)).not.toContain('members');

    // SSM params deleted for the snapshot tenant.
    const ssmDeletes = ssmMock
      .commandCalls(DeleteParameterCommand)
      .map((c) => c.args[0].input.Name);
    expect(ssmDeletes).toContain('/filone/test/aurora-portal/tenant-api-key/aurora-t-1');
    expect(ssmDeletes).toContain('/filone/test/aurora-s3/access-key/aurora-t-1');

    // The DELETION row itself is never batch-deleted.
    const batchedKeys = ddbMock
      .commandCalls(BatchWriteItemCommand)
      .flatMap((c) => Object.values(c.args[0].input.RequestItems!))
      .flat()
      .map((r) => r.DeleteRequest!.Key!.sk.S);
    expect(batchedKeys).not.toContain('DELETION');

    // SUB# row is stripped, not deleted.
    const subUpdates = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((c) => c.args[0].input.Key?.pk?.S === 'SUB#auth0|sub-1');
    expect(subUpdates).toHaveLength(1);
    expect(subUpdates[0].args[0].input.UpdateExpression).toContain('REMOVE userId, orgId');

    // Final status write is DONE with stripped members.
    const statusWrites = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((c) => c.args[0].input.ExpressionAttributeNames?.['#s'] === 'status');
    const finalWrite = statusWrites.at(-1)!.args[0].input;
    expect(
      finalWrite.ExpressionAttributeValues?.[':done']?.S ??
        finalWrite.ExpressionAttributeValues?.[':next']?.S,
    ).toBe(OrgDeletionStatus.Done);
  });

  it('resumes mid-pipeline: STRIPE_CANCELED start skips keys/tenants/stripe', async () => {
    setupHappyMocks(OrgDeletionStatus.StripeCanceled);

    await runAccountDeletion(ORG_ID);

    expect(mockDeleteAccessKey).not.toHaveBeenCalled();
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    expect(mockDeleteAuth0User).toHaveBeenCalledWith('auth0|sub-1');
    expect(mockDropIndex).not.toHaveBeenCalled(); // no RAG rows in this fixture
  });

  it('stops without corrupting state when a region sync fails', async () => {
    setupHappyMocks(OrgDeletionStatus.KeysRevoked);
    mockSync.mockResolvedValue([
      { orchestratorId: 'aurora', tenantId: 'aurora-t-1', outcome: 'error', cause: new Error('x') },
    ]);

    await expect(runAccountDeletion(ORG_ID)).rejects.toThrow(/tenant status sync failed/);

    // Status never advanced past KEYS_REVOKED: no status-advance writes.
    const statusWrites = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((c) => c.args[0].input.ExpressionAttributeNames?.['#s'] === 'status');
    expect(statusWrites).toHaveLength(0);
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });

  it('exits on lost-race when a concurrent invocation advanced the status', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(UpdateItemCommand)
      .resolvesOnce({}) // attemptCount bump
      .rejects(
        new ConditionalCheckFailedException({ message: 'conditional failed', $metadata: {} }),
      );

    await runAccountDeletion(ORG_ID);

    // Lost the PENDING→KEYS_REVOKED race; the loop exits without Stripe work.
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });

  it('treats already-canceled Stripe subscriptions and missing Auth0 users as success', async () => {
    setupHappyMocks(OrgDeletionStatus.TenantsDisabled);
    mockSubscriptionsCancel.mockRejectedValue(
      Object.assign(new Error('No such subscription'), { code: 'resource_missing' }),
    );

    await runAccountDeletion(ORG_ID);

    expect(mockDeleteAuth0User).toHaveBeenCalled(); // pipeline continued
  });

  it('re-disables tenants provisioned after the snapshot (setup race) before purging', async () => {
    setupHappyMocks(OrgDeletionStatus.RagPurged);
    mockGetProvisionedRegions.mockResolvedValue([
      { orchestrator: { id: 'aurora' }, tenantId: 'late-tenant' },
    ]);

    await runAccountDeletion(ORG_ID);

    expect(mockSync).toHaveBeenCalledWith(ORG_ID, 'disabled');
  });

  it('drops vector indexes for RAG rows and tolerates NotFound on re-run', async () => {
    setupHappyMocks(OrgDeletionStatus.Auth0Deleted);
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
    // NotFound swallowed → pipeline reached the purge and finalize steps.
    expect(mockGetProvisionedRegions).toHaveBeenCalled();
  });
});
