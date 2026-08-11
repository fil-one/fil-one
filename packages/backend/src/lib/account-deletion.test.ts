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
  type BatchWriteItemCommandInput,
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
const mockGetAvailableOrchestrators = vi.fn(() => [testOrchestrator] as unknown[]);
vi.mock('./service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: () => testOrchestrator,
  getAvailableOrchestrators: () => mockGetAvailableOrchestrators(),
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
  getOrgProfile: (...args: unknown[]) => mockGetOrgProfile(...args),
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
    // A re-drive of a record whose purge already completed long ago, so
    // Stripe's search-index margin is spent and the pass never has to wait.
    // The wait itself — and the fresh, never-purged record that triggers it —
    // has its own tests below.
    purgedAt: '2026-07-10T00:00:00.000Z',
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
  mockGetAvailableOrchestrators.mockReturnValue([testOrchestrator]);
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
    if (method === 'GET') {
      return Promise.resolve({ id: 'prj_1', status: 'ready', objects: { customers: ['cus_1'] } });
    }
    return Promise.resolve({ id: 'prj_1' });
  });
}

const ORIGINAL_CUSTOMER = 'cus_original';
const RESURRECTED_CUSTOMER = 'cus_resurrected';

/**
 * The state a teardown that ACTUALLY COMPLETED leaves behind, which is the only
 * state a resweep ever runs against — and which `setupHappyMocks(Done)` does
 * NOT produce. That fixture is a pre-purge record with the status flipped: no
 * redaction job id, no tombstone. A real completed teardown always wrote
 * the tombstone and the redaction job BEFORE markDone, and for any org that
 * ever had a customer that tombstone names the ORIGINAL one — so every resweep
 * meets a tombstone/discovery disagreement by construction. Testing against the
 * unrealistic fixture is exactly what hid the fact that a resweep threw before
 * the purge and could never converge.
 *
 * @param discovered what Stripe's live metadata search reports NOW.
 */
function setupCompletedTeardownMocks(discovered: string[]) {
  setupHappyMocks(OrgDeletionStatus.Done);
  ddbMock
    .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
    .resolves({
      Item: deletionItem(OrgDeletionStatus.Done, {
        stripeRedactionJobIds: { [ORIGINAL_CUSTOMER]: 'prj_original' },
      }),
    });
  ddbMock
    .on(GetItemCommand, { Key: { pk: { S: `ORG_TOMBSTONE#${ORG_ID}` }, sk: { S: 'TOMBSTONE' } } })
    .resolves({
      Item: marshall({
        pk: `ORG_TOMBSTONE#${ORG_ID}`,
        sk: 'TOMBSTONE',
        orgId: ORG_ID,
        stripeCustomerId: ORIGINAL_CUSTOMER,
        deletedAt: '2026-07-10T00:00:00.000Z',
      }),
    });
  // mockImplementation, not mockReturnValue: a search result is a one-shot
  // async iterable, so a shared instance would leave the teardown's SECOND
  // Stripe pass reading an exhausted iterator and discovering nothing.
  mockCustomersSearch.mockImplementation(() =>
    stripeSearch(discovered.map((id) => customerHit(id))),
  );
  stubResweepRedactionJobs();
}

/** `prj_original` covers ONLY the original customer; anyone else needs a new job. */
function stubResweepRedactionJobs(newJobStatus = 'ready') {
  mockRawRequest.mockImplementation((method: string, path: string) => {
    if (path === '/v1/privacy/redaction_jobs/prj_original') {
      return Promise.resolve({
        id: 'prj_original',
        status: 'ready',
        objects: { customers: [ORIGINAL_CUSTOMER] },
      });
    }
    if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
      return Promise.resolve({ id: 'prj_new', status: 'created' });
    }
    if (method === 'GET') {
      return Promise.resolve({
        id: 'prj_new',
        status: newJobStatus,
        objects: { customers: [RESURRECTED_CUSTOMER] },
      });
    }
    return Promise.resolve({ id: 'prj_new' });
  });
}

/** BillingTable key deletes issued by the purge. */
function billingDeletes() {
  return ddbMock
    .commandCalls(DeleteItemCommand)
    .map((c) => c.args[0].input)
    .filter((input) => input.TableName === 'BillingTable')
    .map((input) => unmarshall(input.Key!));
}

/** Redaction jobs created this pass, by the customers they were asked to cover. */
function createdRedactionJobCustomers(): string[][] {
  return mockRawRequest.mock.calls
    .filter(([method, path]) => method === 'POST' && path === '/v1/privacy/redaction_jobs')
    .map(([, , params]) => (params as { objects: { customers: string[] } }).objects.customers);
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

  it('billing allowlist: permits CUSTOMER#, DELETION_CHALLENGE# and ORG# rows only', () => {
    expect(() => assertPurgeablePk('CUSTOMER#u-1', PURGEABLE_BILLING_PK_PREFIXES)).not.toThrow();
    expect(() =>
      assertPurgeablePk('DELETION_CHALLENGE#org-1', PURGEABLE_BILLING_PK_PREFIXES),
    ).not.toThrow();
    // The usage-reporting worker's audit rows; previously unpurgeable, so they
    // outlived the deletion until their 365-day TTL.
    expect(() => assertPurgeablePk('ORG#org-1', PURGEABLE_BILLING_PK_PREFIXES)).not.toThrow();
  });

  it('billing allowlist: refuses EMAIL_NORM# (trial claims) and the ORG_TOMBSTONE#, which must outlive the account', () => {
    expect(() =>
      assertPurgeablePk('EMAIL_NORM#user@gmail.com', PURGEABLE_BILLING_PK_PREFIXES),
    ).toThrow(/outside the purgeable prefixes/);
    // The trailing '#' on 'ORG#' is what keeps the tombstone out of reach.
    expect(() => assertPurgeablePk('ORG_TOMBSTONE#org-1', PURGEABLE_BILLING_PK_PREFIXES)).toThrow(
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

  it('caps the retries and throws on exhaustion so the orchestrator re-drives', async () => {
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

  it('is a no-op when already DONE and NOT re-sweeping: an ordinary re-invocation runs no externals', async () => {
    setupCompletedTeardownMocks([ORIGINAL_CUSTOMER]);

    await runAccountDeletion(ORG_ID);

    expect(mockDeleteTenant).not.toHaveBeenCalled();
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    expect(mockDeleteAuth0User).not.toHaveBeenCalled();
    // Not even an attemptCount bump.
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  // Every resweep runs against a record a teardown ACTUALLY finished: a
  // tombstone naming the original customer and a stored redaction job id. The
  // three shapes below are the complete set the resurrection can present, and
  // the first two are the ones that used to throw before purgeRecords ever ran
  // — the zombie row survived, the record stayed DONE, and the sweep re-threw
  // every 12h forever.
  describe('resweep of a genuinely completed teardown', () => {
    it('case 1 — original customer STILL discoverable alongside the new one: purges, and redacts the new customer', async () => {
      // Discovery returns two customers, so the 1:1 invariant reads as broken
      // and the multi-customer guard used to throw out of settleAll.
      setupCompletedTeardownMocks([ORIGINAL_CUSTOMER, RESURRECTED_CUSTOMER]);

      await runAccountDeletion(ORG_ID, { resweep: true });

      expect(billingDeletes()).toContainEqual({ pk: 'CUSTOMER#user-1', sk: 'SUBSCRIPTION' });
      // Billing stopped on BOTH, and the resurrected customer got its own job.
      expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_original');
      expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_resurrected');
      expect(createdRedactionJobCustomers()).toContainEqual([RESURRECTED_CUSTOMER]);
      expect(doneWrites()).toHaveLength(1);
    });

    it('case 2 — original customer no longer discoverable (its metadata was redacted): purges, and redacts the new customer', async () => {
      // Only the resurrected customer comes back, so discovery disagrees with
      // the tombstone and the mismatch guard used to throw.
      setupCompletedTeardownMocks([RESURRECTED_CUSTOMER]);

      await runAccountDeletion(ORG_ID, { resweep: true });

      expect(billingDeletes()).toContainEqual({ pk: 'CUSTOMER#user-1', sk: 'SUBSCRIPTION' });
      expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_resurrected');
      // The stored job covers the ORIGINAL customer, so it must not be reused.
      expect(createdRedactionJobCustomers()).toContainEqual([RESURRECTED_CUSTOMER]);
      expect(doneWrites()).toHaveLength(1);
    });

    it('case 2 — the tombstone keeps naming the original customer, and the new one is recorded for audit', async () => {
      setupCompletedTeardownMocks([RESURRECTED_CUSTOMER]);

      await runAccountDeletion(ORG_ID, { resweep: true });

      // Never overwritten: that would strand the original with no pointer left
      // to redact it by. It is the DELETION record that carries the new one.
      const tombstoneWrites = ddbMock
        .commandCalls(PutItemCommand)
        .filter((c) => c.args[0].input.Item?.pk?.S === `ORG_TOMBSTONE#${ORG_ID}`);
      expect(tombstoneWrites).toHaveLength(0);

      const audit = ddbMock
        .commandCalls(UpdateItemCommand)
        .map((c) => c.args[0].input)
        .filter((input) => input.UpdateExpression?.includes('resurrectedStripeCustomerIds'));
      expect(audit.length).toBeGreaterThan(0);
      // list_append over if_not_exists, never a SET from an in-memory snapshot:
      // two overlapping resweeps that each found a different customer would
      // otherwise drop one, and this list is what the sweep re-drives by.
      expect(audit[0].UpdateExpression).toContain(
        'list_append(if_not_exists(resurrectedStripeCustomerIds, :empty), :new)',
      );
      expect(unmarshall(audit[0].ExpressionAttributeValues!)[':new']).toEqual([
        RESURRECTED_CUSTOMER,
      ]);
    });

    it('case 3 — a DynamoDB row with no Stripe customer behind it: purges and re-marks DONE', async () => {
      setupCompletedTeardownMocks([]);

      await runAccountDeletion(ORG_ID, { resweep: true });

      expect(billingDeletes()).toContainEqual({ pk: 'CUSTOMER#user-1', sk: 'SUBSCRIPTION' });
      expect(createdRedactionJobCustomers()).toHaveLength(0);
      expect(doneWrites()).toHaveLength(1);
    });

    it('runs the same full pass a live teardown does — not a purge-only path', async () => {
      // The writer that resurrects a CUSTOMER# row (createBillingTrial) also
      // mints a live Stripe customer + trial subscription, so deleting the
      // DynamoDB row alone would leave a deleted account billing.
      setupCompletedTeardownMocks([RESURRECTED_CUSTOMER]);

      await runAccountDeletion(ORG_ID, { resweep: true });

      expect(mockDeleteTenant).toHaveBeenCalledWith('aurora-t-1');
      expect(mockDeleteAuth0User).toHaveBeenCalledWith('auth0|sub-1');
      expect(ddbMock.commandCalls(ScanCommand).length).toBeGreaterThan(0); // RAG purge
    });

    it('redacts a customer an earlier resweep recorded even once discovery can no longer see it', async () => {
      // Redaction nulls the `metadata.userId` discovery searches on, so a job
      // caught mid-lifecycle becomes invisible to discovery exactly when it
      // starts working. Driving only what discovery returns would leave the
      // sweep re-driving this org forever for a customer nothing ever touches.
      setupCompletedTeardownMocks([]);
      ddbMock
        .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
        .resolves({
          Item: deletionItem(OrgDeletionStatus.Done, {
            stripeRedactionJobIds: { [ORIGINAL_CUSTOMER]: 'prj_original' },
            resurrectedStripeCustomerIds: ['cus_ghost'],
          }),
        });

      await runAccountDeletion(ORG_ID, { resweep: true });

      expect(createdRedactionJobCustomers()).toContainEqual(['cus_ghost']);
      expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_ghost');
      // Already recorded, so nothing is appended a second time.
      const audit = ddbMock
        .commandCalls(UpdateItemCommand)
        .map((c) => c.args[0].input)
        .filter((input) => input.UpdateExpression?.includes('resurrectedStripeCustomerIds'));
      expect(audit).toHaveLength(0);
    });

    it('does not cry "late find" about a customer the FIRST pass was already looking at', async () => {
      // When pass 1's Stripe surface throws, it has no finding to hand pass 2.
      // Inventing an empty one made every held Stripe failure warn that a
      // customer had been minted inside the deletion race window — a false
      // alarm, on a destructive path, about a customer found all along.
      setupCompletedTeardownMocks([RESURRECTED_CUSTOMER]);
      stubResweepRedactionJobs('validating'); // both passes throw
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await expect(runAccountDeletion(ORG_ID, { resweep: true })).rejects.toThrow();

        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('Late Stripe customer discovered after purge'),
          expect.anything(),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('purges the DynamoDB residue even when the Stripe half fails, then throws loudly', async () => {
      // A permanent silent loop is worse than a purge plus a distinct alarm:
      // whatever Stripe needs, the zombie rows must stop coming back.
      setupCompletedTeardownMocks([RESURRECTED_CUSTOMER]);
      stubResweepRedactionJobs('validating'); // new job not ready — throws

      await expect(runAccountDeletion(ORG_ID, { resweep: true })).rejects.toThrow(
        /purged its resurrected records but could not finish the Stripe half/,
      );

      expect(billingDeletes()).toContainEqual({ pk: 'CUSTOMER#user-1', sk: 'SUBSCRIPTION' });
      // The record was already DONE; nothing re-stamps it on a failed pass.
      expect(doneWrites()).toHaveLength(0);
    });
  });

  it('runs every external teardown, purges the records, and marks DONE', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock.on(QueryCommand, { TableName: 'UserInfoTable' }).resolves({
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

    // Tombstone written to BillingTable without PII and without a ttl. Two
    // writes here because the stub reports NO existing tombstone on every read,
    // so both Stripe passes see one to create; against a real table the second
    // pass reads its own write back and skips (see the deletedAt test below).
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

    // attemptCount bumped for the orchestrator's stuck gauge.
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

  it('touches updatedAt on every attemptCount bump so a live worker never looks stale to the orchestrator', async () => {
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

  it('settles the late-region re-check too: one straggler failing does not skip the others', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    const downTenant = vi.fn().mockRejectedValue(new Error('aurora is down'));
    const otherTenant = vi.fn().mockResolvedValue(undefined);
    mockGetRegionsWithTenantIdsForOrg.mockResolvedValue([
      { orchestrator: { id: 'aurora', deleteTenant: downTenant }, tenantId: 'late-aurora' },
      { orchestrator: { id: 'fth', deleteTenant: otherTenant }, tenantId: 'late-fth' },
    ]);

    const err = (await runAccountDeletion(ORG_ID).catch((e: unknown) => e)) as AggregateError;

    expect(otherTenant).toHaveBeenCalledWith('late-fth');
    expect(err.message).toMatch(/Late-region teardown failed for org org-1 in: aurora/);
    expect(doneWrites()).toHaveLength(0);
  });

  it('resolves teardown regions from a STRONGLY CONSISTENT profile read', async () => {
    // A stale read here reports "no tenant in this region", the region is
    // skipped, and the profile — the only pointer to the tenant id — is purged
    // moments later, leaking a live upstream tenant permanently.
    setupHappyMocks(OrgDeletionStatus.Pending);

    await runAccountDeletion(ORG_ID);

    expect(mockGetOrgProfile).toHaveBeenCalledWith(ORG_ID, { consistent: true });
    expect(mockGetOrgProfile.mock.calls.every(([, options]) => options?.consistent === true)).toBe(
      true,
    );
  });

  it('settles every region before failing: one region going down does not skip the others', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    const downTenant = vi.fn().mockRejectedValue(new Error('aurora is down'));
    const otherTenant = vi.fn().mockResolvedValue(undefined);
    mockGetAvailableOrchestrators.mockReturnValue([
      { id: 'aurora', deleteTenant: downTenant },
      { id: 'fth', deleteTenant: otherTenant },
    ]);
    mockGetOrgProfile.mockResolvedValue({
      pk: { S: `ORG#${ORG_ID}` },
      sk: { S: 'PROFILE' },
      auroraTenantId: { S: 'aurora-t-1' },
      fthTenantId: { S: 'fth-t-1' },
    });

    const err = (await runAccountDeletion(ORG_ID).catch((e: unknown) => e)) as AggregateError;

    // The healthy region was torn down even though the first one threw.
    expect(otherTenant).toHaveBeenCalledWith('fth-t-1');
    expect(err.errors.map(String).join('\n')).toMatch(/Region teardown failed .* in: aurora/);
    expect(doneWrites()).toHaveLength(0);
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

  it('purges the RAGKEYHASH lookup rows BEFORE the ORG# partition delete, from the same snapshot', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    // One partition query feeds both deletes. Deriving the hashes from the SAME
    // snapshot that drives the partition delete is what removes the orphan
    // window: a key created between two separate queries used to have its
    // RAGKEY# row swept while its lookup row survived forever.
    ddbMock.on(QueryCommand, { TableName: 'UserInfoTable' }).resolves({
      Items: [
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'PROFILE' }),
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'RAGKEY#key-1', tokenHash: 'hash-1' }),
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'RAGKEY#key-2', tokenHash: 'hash-2' }),
      ],
    });

    await runAccountDeletion(ORG_ID);

    const userInfoBatches = ddbMock
      .commandCalls(BatchWriteItemCommand)
      .map((c) =>
        (c.args[0].input.RequestItems?.UserInfoTable ?? []).map((r) =>
          unmarshall(r.DeleteRequest!.Key!),
        ),
      )
      .filter((batch) => batch.length > 0);

    const flat = userInfoBatches.flat();
    expect(flat).toContainEqual({ pk: 'RAGKEYHASH#hash-1', sk: 'LOOKUP' });
    expect(flat).toContainEqual({ pk: 'RAGKEYHASH#hash-2', sk: 'LOOKUP' });

    // Ordering: the lookup delete precedes the partition delete, for crash
    // convergence. batchDelete throws once its retries are exhausted, and a
    // re-drive re-queries the partition — so if the partition went first, an
    // interrupted purge would leave a RAGKEYHASH# row that NO later pass could
    // ever find again (its only pointer, the RAGKEY# row's tokenHash, is gone).
    // This way an interruption leaves an unusable key, swept next pass.
    const lookupBatch = userInfoBatches.findIndex((batch) =>
      batch.some((key) => key.pk === 'RAGKEYHASH#hash-1'),
    );
    const partitionBatch = userInfoBatches.findIndex((batch) =>
      batch.some((key) => key.sk === 'RAGKEY#key-1'),
    );
    expect(lookupBatch).toBeGreaterThanOrEqual(0);
    expect(partitionBatch).toBeGreaterThan(lookupBatch);
    expect(doneWrites()).toHaveLength(1);
  });

  it('leaves no unreachable RAGKEYHASH row when the partition delete is interrupted', async () => {
    // The regression this pins: batchDelete throws on exhausted UnprocessedItems
    // (throttling — most likely on the biggest orgs), and mid-purge interruption
    // is the expected model for a 900s teardown. Whatever the partition delete
    // fails to remove must still be re-derivable on the next pass, which means
    // the credential hashes have to be gone first.
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock.on(QueryCommand, { TableName: 'UserInfoTable' }).resolves({
      Items: [
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'RAGKEY#key-1', tokenHash: 'hash-1' }),
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'ACCESSKEY#k' }),
      ],
    });
    // The ORG# partition chunk is shed for good (throttling); everything else
    // is accepted. batchDelete gives up after its retries and throws.
    ddbMock.on(BatchWriteItemCommand).callsFake((input: BatchWriteItemCommandInput) => {
      const requests = input.RequestItems?.UserInfoTable ?? [];
      const isOrgPartition = requests.some(
        (r) => unmarshall(r.DeleteRequest!.Key!).pk === `ORG#${ORG_ID}`,
      );
      return isOrgPartition ? { UnprocessedItems: input.RequestItems } : {};
    });

    vi.useFakeTimers();
    const run = runAccountDeletion(ORG_ID);
    const assertion = expect(run).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();

    // The lookup rows are gone even though the purge did not finish, so the
    // re-drive never needs the tokenHash it can no longer read.
    const deleted = ddbMock
      .commandCalls(BatchWriteItemCommand)
      .flatMap((c) => c.args[0].input.RequestItems?.UserInfoTable ?? [])
      .map((r) => unmarshall(r.DeleteRequest!.Key!));
    expect(deleted).toContainEqual({ pk: 'RAGKEYHASH#hash-1', sk: 'LOOKUP' });
    // And the record is NOT marked done, so the reconciler re-drives.
    expect(doneWrites()).toHaveLength(0);
  });

  it('purges the BillingTable ORG# usage-audit rows, leaving the tombstone partition alone', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock.on(QueryCommand, { TableName: 'BillingTable' }).resolves({
      Items: [
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'USAGE_REPORT#2026-08-01' }),
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'USAGE_REPORT#2026-08-02' }),
      ],
    });

    await runAccountDeletion(ORG_ID);

    const billingDeletes = ddbMock
      .commandCalls(BatchWriteItemCommand)
      .flatMap((c) => c.args[0].input.RequestItems?.BillingTable ?? [])
      .map((r) => unmarshall(r.DeleteRequest!.Key!));
    expect(billingDeletes).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: 'USAGE_REPORT#2026-08-01' },
      { pk: `ORG#${ORG_ID}`, sk: 'USAGE_REPORT#2026-08-02' },
    ]);
    // The ORG_TOMBSTONE# partition is never queried and never batch-deleted.
    expect(
      ddbMock
        .commandCalls(QueryCommand)
        .map((c) => unmarshall(c.args[0].input.ExpressionAttributeValues!)[':pk']),
    ).not.toContain(`ORG_TOMBSTONE#${ORG_ID}`);
  });

  it('scopes the BillingTable purge to USAGE_REPORT# rows rather than the whole partition', async () => {
    // This is an unrecoverable delete. Querying the bare `ORG#{orgId}` partition
    // would silently pull any future row written there into its scope; a row
    // that should be purged has to be added to the prefix deliberately.
    setupHappyMocks(OrgDeletionStatus.Pending);

    await runAccountDeletion(ORG_ID);

    const billingQuery = ddbMock
      .commandCalls(QueryCommand)
      .map((c) => c.args[0].input)
      .find((input) => input.TableName === 'BillingTable');
    expect(billingQuery?.KeyConditionExpression).toBe('pk = :pk AND begins_with(sk, :skPrefix)');
    expect(unmarshall(billingQuery!.ExpressionAttributeValues!)).toEqual({
      ':pk': `ORG#${ORG_ID}`,
      ':skPrefix': 'USAGE_REPORT#',
    });
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

  it('anchors the search-index wait on the PURGE, not on when the user asked to be deleted', async () => {
    // The bug this pins: the hazard is a customer minted DURING the deletion
    // race being invisible to discovery, i.e. `discovery - customerCreatedAt <
    // lag`. Anchoring the margin on `requestedAt` only bounds a mint at the
    // instant of the request. On a big org whose pass runs for minutes, an
    // in-flight request that beat the fence can mint a customer near the END of
    // the pass — long after a requestedAt margin has "elapsed" — and the
    // post-purge discovery then runs seconds later, still inside the lag,
    // finds nothing, and markDone leaves the record inert with that PII intact.
    // So: requestedAt is ancient here, and the pass must STILL wait.
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
      .resolves({
        Item: deletionItem(OrgDeletionStatus.Pending, {
          requestedAt: new Date(Date.now() - 300_000).toISOString(),
          purgedAt: undefined, // this pass is the one that purges
        }),
      });

    vi.useFakeTimers();
    let settled = false;
    const run = runAccountDeletion(ORG_ID).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(59_000);

    // Everything is done except the finish — no DONE, no second discovery.
    expect(settled).toBe(false);
    expect(mockDeleteTenant).toHaveBeenCalled();
    expect(mockCustomersSearch).toHaveBeenCalledTimes(1);
    expect(doneWrites()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    vi.useRealTimers();

    expect(mockCustomersSearch).toHaveBeenCalledTimes(2);
    expect(doneWrites()).toHaveLength(1);
  });

  it('waits IN-PASS rather than deferring: one invocation, one teardown, one attempt bump', async () => {
    // Deferring with a throw would emit a Lambda `Errors` datapoint for every
    // healthy deletion (the metric Grafana alerts on), burn an async retry,
    // push `attemptCount` toward the reconciler's stuck threshold, refresh the
    // staleness window, and re-run every external teardown and the whole purge.
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
      .resolves({
        Item: deletionItem(OrgDeletionStatus.Pending, {
          // A just-requested, never-purged record: the case that used to throw
          // a deferral and hand the wait to the Lambda retry.
          requestedAt: new Date(Date.now() - 5_000).toISOString(),
          purgedAt: undefined,
        }),
      });

    vi.useFakeTimers();
    const run = runAccountDeletion(ORG_ID);
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    vi.useRealTimers();

    expect(doneWrites()).toHaveLength(1);
    expect(mockDeleteTenant).toHaveBeenCalledTimes(1);
    const attemptBumps = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((c) => c.args[0].input.UpdateExpression?.includes('ADD attemptCount'));
    expect(attemptBumps).toHaveLength(1);
  });

  it('a re-drive of an org purged 45s ago waits only the remaining 15s', async () => {
    // `purgedAt` is already 45s old at the START of this pass, which only ever
    // happens on a re-drive — a first pass stamps it at the end of its own
    // purge and so always waits the full 60s. Here 15s of margin is left.
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
      .resolves({
        Item: deletionItem(OrgDeletionStatus.Pending, {
          purgedAt: new Date(Date.now() - 45_000).toISOString(),
        }),
      });

    vi.useFakeTimers();
    let settled = false;
    const run = runAccountDeletion(ORG_ID).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    vi.useRealTimers();

    expect(doneWrites()).toHaveLength(1);
  });

  it('stamps purgedAt once, keeping the earliest purge across re-drives', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);

    await runAccountDeletion(ORG_ID);

    const stamps = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((c) => c.args[0].input.UpdateExpression?.includes('purgedAt'));
    expect(stamps).toHaveLength(1);
    expect(stamps[0].args[0].input.UpdateExpression).toBe(
      'SET purgedAt = if_not_exists(purgedAt, :purgedAt), updatedAt = :now',
    );
    // Minting became impossible at the FIRST purge, so a re-drive must not
    // restart the wait: the stored value is re-sent, never a fresh `now`.
    expect(stamps[0].args[0].input.ExpressionAttributeValues?.[':purgedAt']?.S).toBe(
      '2026-07-10T00:00:00.000Z',
    );
  });

  it('does not wedge a legacy record that predates purgedAt (or carries a corrupt one)', async () => {
    // lib/dynamo-records.ts documents that legacy DELETION records exist and
    // instructs readers to tolerate them. Hard-failing on a timestamp retries
    // into a DLQ that has no consumer; an early discovery pass is far cheaper.
    setupHappyMocks(OrgDeletionStatus.Pending);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
      .resolves({
        Item: deletionItem(OrgDeletionStatus.Pending, {
          purgedAt: 'not-a-date',
          requestedAt: undefined,
        }),
      });

    await runAccountDeletion(ORG_ID);

    expect(doneWrites()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no usable purgedAt'),
      expect.objectContaining({ orgId: ORG_ID }),
    );
    warn.mockRestore();
  });

  it('caps the wait at the margin when purgedAt is in the future (clock skew)', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } } })
      .resolves({
        Item: deletionItem(OrgDeletionStatus.Pending, {
          purgedAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      });

    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const run = runAccountDeletion(ORG_ID);
    // An hour of skew must not park the pass for an hour — one margin, no more.
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    vi.useRealTimers();

    expect(doneWrites()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Waiting out Stripe's search-index lag"),
      expect.objectContaining({ remainingMs: 60_000, clockSkewed: true }),
    );
    warn.mockRestore();
  });

  it('writes the tombstone conditionally so an overlapping worker cannot swap the customer id', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);

    await runAccountDeletion(ORG_ID);

    const put = tombstoneWrites()[0].args[0].input;
    expect(put.ConditionExpression).toBe(
      'attribute_not_exists(pk) OR attribute_not_exists(stripeCustomerId) OR stripeCustomerId = :id',
    );
    expect(put.ExpressionAttributeValues?.[':id']?.S).toBe('cus_1');
  });

  it('a pass that discovers no customer cannot overwrite a tombstone that names one', async () => {
    // The read is only a snapshot: a concurrent worker can land a customer
    // tombstone between it and this write. Without the condition, this pass
    // would replace it with an item carrying no stripeCustomerId at all,
    // destroying the last pointer to redact that customer by.
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockCustomersSearch.mockReturnValue(stripeSearch([]));

    await runAccountDeletion(ORG_ID);

    expect(tombstoneWrites()[0].args[0].input.ConditionExpression).toBe(
      'attribute_not_exists(pk) OR attribute_not_exists(stripeCustomerId)',
    );
    expect(tombstoneWrites()[0].args[0].input.ExpressionAttributeValues).toBeUndefined();
  });

  it('surfaces a lost tombstone race instead of completing the teardown', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(PutItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'raced', $metadata: {} }));

    const err = (await runAccountDeletion(ORG_ID).catch((e: unknown) => e)) as AggregateError;

    expect(err.errors.map(String).join('\n')).toMatch(/tombstone was written concurrently/);
    expect(doneWrites()).toHaveLength(0);
  });

  it('accepts a concurrent tombstone UPGRADE: losing that race is not a failure', async () => {
    // This pass discovers nothing, so it had nothing to write; a worker that
    // landed a customer id first has a strictly better tombstone. Treating the
    // rejected write as fatal failed the whole teardown over an outcome that is
    // exactly what we wanted — and left the record non-DONE for a re-drive that
    // would hit the same benign race again.
    setupHappyMocks(OrgDeletionStatus.Pending);
    mockCustomersSearch.mockReturnValue(stripeSearch([]));
    const tombstoneKey = { pk: { S: `ORG_TOMBSTONE#${ORG_ID}` }, sk: { S: 'TOMBSTONE' } };
    ddbMock
      .on(GetItemCommand, { Key: tombstoneKey })
      // Read: nothing there yet. Re-read after the rejection: the winner's.
      .resolvesOnce({})
      .resolves({
        Item: marshall({
          pk: `ORG_TOMBSTONE#${ORG_ID}`,
          sk: 'TOMBSTONE',
          orgId: ORG_ID,
          stripeCustomerId: 'cus_winner',
          deletedAt: '2026-07-10T00:00:00.000Z',
        }),
      });
    ddbMock
      .on(PutItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'raced', $metadata: {} }));

    await runAccountDeletion(ORG_ID);

    expect(doneWrites()).toHaveLength(1);
  });

  it('leaves deletedAt alone when the tombstone already records the same customer', async () => {
    // deletedAt answers "when was this org deleted?" — re-stamping it on every
    // pass drifts the audit trail toward whenever the last retry happened.
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG_TOMBSTONE#${ORG_ID}` }, sk: { S: 'TOMBSTONE' } } })
      .resolves({
        Item: marshall({
          pk: `ORG_TOMBSTONE#${ORG_ID}`,
          sk: 'TOMBSTONE',
          orgId: ORG_ID,
          stripeCustomerId: 'cus_1',
          deletedAt: '2026-07-10T00:00:00.000Z',
        }),
      });

    await runAccountDeletion(ORG_ID);

    expect(tombstoneWrites()).toHaveLength(0);
    expect(doneWrites()).toHaveLength(1);
  });

  it('upgrades an id-less tombstone when the post-purge pass finds a late customer', async () => {
    setupHappyMocks(OrgDeletionStatus.Pending);
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG_TOMBSTONE#${ORG_ID}` }, sk: { S: 'TOMBSTONE' } } })
      .resolves({
        Item: marshall({
          pk: `ORG_TOMBSTONE#${ORG_ID}`,
          sk: 'TOMBSTONE',
          orgId: ORG_ID,
          deletedAt: '2026-07-10T00:00:00.000Z',
        }),
      });
    mockCustomersSearch.mockReturnValue(stripeSearch([customerHit('cus_late')]));

    await runAccountDeletion(ORG_ID);

    const put = tombstoneWrites()[0].args[0].input;
    expect(put.Item!.stripeCustomerId?.S).toBe('cus_late');
    // The original deletion timestamp is preserved, not re-stamped.
    expect(put.Item!.deletedAt?.S).toBe('2026-07-10T00:00:00.000Z');
    expect(doneWrites()).toHaveLength(1);
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
