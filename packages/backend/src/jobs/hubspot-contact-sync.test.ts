import {
  BatchGetItemCommand,
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MetricEvent, reportMetric } from '../lib/metrics.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockUpsertContact = vi.fn();
vi.mock('../lib/hubspot-client.js', () => ({
  upsertContactSubscriptionStatus: (...args: unknown[]) => mockUpsertContact(...args),
}));

vi.mock('../lib/metrics.js', () => ({ reportMetric: vi.fn() }));

const reportMetricMock = vi.mocked(reportMetric);
const ddbMock = mockClient(DynamoDBClient);

import { handler, syncAllContacts } from './hubspot-contact-sync.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMAIL = 'a@example.com';

/** Every counter at zero — spread it so a new one stuck at 0 fails a toEqual. */
const NOTHING = {
  total: 0,
  matched: 0,
  unmatched: 0,
  writeFailed: 0,
  repaired: 0,
  truncated: 0,
  missingEmail: 0,
  missingUserId: 0,
};

function subRow(overrides?: Record<string, unknown>) {
  return marshall(
    {
      pk: 'ORG#org-1',
      sk: 'SUBSCRIPTION',
      orgId: 'org-1',
      userId: 'user-1',
      stripeCustomerId: 'cus_1',
      subscriptionStatus: SubscriptionStatus.Active,
      ...overrides,
    },
    { removeUndefinedValues: true },
  );
}

function profileRow(userId: string, email?: string) {
  return marshall({ pk: `USER#${userId}`, sk: 'PROFILE', ...(email ? { email } : {}) });
}

function setupScan(...items: Record<string, unknown>[]) {
  ddbMock.on(ScanCommand).resolves({ Items: items as never });
}

function setupProfiles(...items: Record<string, unknown>[]) {
  ddbMock.on(BatchGetItemCommand).resolves({ Responses: { UserInfoTable: items as never } });
}

const upsertCalls = () => mockUpsertContact.mock.calls.map(([args]) => args);
const scanInput = () => ddbMock.commandCalls(ScanCommand)[0]!.args[0].input;
const stampedKeys = () =>
  ddbMock.commandCalls(UpdateItemCommand).map((call) => call.args[0].input.Key?.pk?.S);
const stampInput = () => ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input;
const profileKeysRequested = () =>
  ddbMock
    .commandCalls(BatchGetItemCommand)
    .flatMap((call) => call.args[0].input.RequestItems?.UserInfoTable?.Keys ?? [])
    .map((key) => key.pk?.S);

describe('hubspot-contact-sync', () => {
  beforeEach(() => {
    ddbMock.reset();
    mockUpsertContact.mockReset();
    reportMetricMock.mockReset();
    mockUpsertContact.mockResolvedValue('updated');
    ddbMock.on(UpdateItemCommand).resolves({});
    setupProfiles(profileRow('user-1', EMAIL));
  });

  it('bootstraps an unstamped contact and does not count it as repaired', async () => {
    setupScan(subRow());
    mockUpsertContact.mockResolvedValue('bootstrapped');

    const summary = await syncAllContacts();

    expect(upsertCalls()).toEqual([{ userId: 'user-1', status: 'paying', email: EMAIL }]);
    expect(summary).toEqual({ ...NOTHING, total: 1, matched: 1 });
  });

  it('repairs a stamp that disagrees with the row and counts a dropped write', async () => {
    setupScan(subRow({ hubspotSubscriptionStatus: SubscriptionStatus.Trialing }));

    const summary = await syncAllContacts();

    expect(upsertCalls()).toEqual([{ userId: 'user-1', status: 'paying', email: EMAIL }]);
    expect(summary).toEqual({ ...NOTHING, total: 1, matched: 1, repaired: 1 });
  });

  it('takes the bootstrap address from the profile row, keyed by user id', async () => {
    setupScan(subRow({ userId: 'user-7' }));
    setupProfiles(profileRow('user-7', 'seven@example.com'));

    await syncAllContacts();

    expect(profileKeysRequested()).toEqual(['USER#user-7']);
    expect(upsertCalls()).toEqual([
      { userId: 'user-7', status: 'paying', email: 'seven@example.com' },
    ]);
  });

  it('counts a candidate whose profile row holds no address', async () => {
    setupScan(subRow());
    setupProfiles(profileRow('user-1'));

    const summary = await syncAllContacts();

    expect(upsertCalls()).toEqual([{ userId: 'user-1', status: 'paying', email: undefined }]);
    expect(summary).toEqual({ ...NOTHING, total: 1, matched: 1, missingEmail: 1 });
  });

  it('counts a candidate with no profile row at all', async () => {
    setupScan(subRow());
    setupProfiles();

    const summary = await syncAllContacts();

    expect(summary).toEqual({ ...NOTHING, total: 1, matched: 1, missingEmail: 1 });
  });

  it('counts a row naming no user rather than dropping it out of the totals', async () => {
    setupScan(subRow({ userId: undefined }), subRow({ pk: 'ORG#org-2', orgId: 'org-2' }));

    const summary = await syncAllContacts();

    expect(upsertCalls()).toEqual([{ userId: 'user-1', status: 'paying', email: EMAIL }]);
    expect(summary).toEqual({ ...NOTHING, total: 1, matched: 1, missingUserId: 1 });
  });

  it('stamps the org row with what HubSpot now holds', async () => {
    setupScan(subRow());

    await syncAllContacts();

    const stamps = ddbMock.commandCalls(UpdateItemCommand);
    expect(stamps).toHaveLength(1);
    const input = stamps[0]!.args[0].input;
    expect(input.Key).toEqual({ pk: { S: 'ORG#org-1' }, sk: { S: 'SUBSCRIPTION' } });
    expect(input.ExpressionAttributeValues![':status']).toEqual({ S: SubscriptionStatus.Active });
    expect(input.ExpressionAttributeValues![':syncedAt']!.S).toBeTruthy();
    expect(input.UpdateExpression).toBe(
      'SET hubspotSubscriptionStatus = :status, hubspotSyncedAt = :syncedAt',
    );
    expect(input.ConditionExpression).toBe('attribute_exists(pk)');
  });

  it('records the attempt on a contact HubSpot could not match, claiming no status', async () => {
    setupScan(subRow());
    mockUpsertContact.mockResolvedValue('unmatched');

    const summary = await syncAllContacts();

    // Recorded, or this row is eligible on every future run and a hundred like
    // it fill the per-run cap while the rest of the backlog goes untouched.
    expect(stampedKeys()).toEqual(['ORG#org-1']);
    const input = stampInput();
    expect(input.UpdateExpression).toBe(
      'SET hubspotSyncedAt = :syncedAt REMOVE hubspotSubscriptionStatus',
    );
    expect(Object.keys(input.ExpressionAttributeValues!)).toEqual([':syncedAt']);
    expect(summary).toEqual({ ...NOTHING, total: 1, unmatched: 1 });
  });

  it('clears a stale status claim when HubSpot no longer holds the contact', async () => {
    setupScan(subRow({ hubspotSubscriptionStatus: SubscriptionStatus.Trialing }));
    mockUpsertContact.mockResolvedValue('unmatched');

    await syncAllContacts();

    // Left standing, the disagreeing-status clause re-selects this row forever.
    expect(stampInput().UpdateExpression).toContain('REMOVE hubspotSubscriptionStatus');
  });

  it('records nothing when the write threw, so the next run retries it', async () => {
    setupScan(subRow());
    mockUpsertContact.mockRejectedValue(new Error('HubSpot 503'));

    const summary = await syncAllContacts();

    expect(stampedKeys()).toEqual([]);
    expect(summary).toEqual({ ...NOTHING, total: 1, writeFailed: 1 });
  });

  it('treats a row deleted between the scan and the stamp as a no-op', async () => {
    setupScan(subRow());
    ddbMock.on(UpdateItemCommand).rejects(
      Object.assign(new Error('The conditional request failed'), {
        name: 'ConditionalCheckFailedException',
      }),
    );

    const summary = await syncAllContacts();

    expect(summary).toEqual({ ...NOTHING, total: 1, matched: 1 });
  });

  it('caps the run and reports that rows were left behind', async () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      subRow({ pk: `ORG#org-${i}`, orgId: `org-${i}`, userId: `user-${i}` }),
    );
    ddbMock.on(ScanCommand).resolves({ Items: rows as never });
    setupProfiles();

    const summary = await syncAllContacts();

    expect(summary.total).toBe(100);
    expect(summary.truncated).toBe(1);
    // Over 100 keys in one BatchGetItem is a ValidationException.
    expect(profileKeysRequested()).toHaveLength(100);
  });

  it('reports no backlog when exactly a batch was pending', async () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      subRow({ pk: `ORG#org-${i}`, orgId: `org-${i}`, userId: `user-${i}` }),
    );
    ddbMock.on(ScanCommand).resolves({ Items: rows as never });
    setupProfiles();

    const summary = await syncAllContacts();

    expect(summary.total).toBe(100);
    expect(summary.truncated).toBe(0);
  });

  it('asks for one profile key when two orgs share an owner', async () => {
    setupScan(subRow(), subRow({ pk: 'ORG#org-2', orgId: 'org-2' }));

    await syncAllContacts();

    expect(profileKeysRequested()).toEqual(['USER#user-1']);
    expect(upsertCalls()).toHaveLength(2);
  });

  it('reads no profiles at all when nothing is pending', async () => {
    setupScan();

    const summary = await syncAllContacts();

    expect(ddbMock.commandCalls(BatchGetItemCommand)).toEqual([]);
    expect(summary).toEqual(NOTHING);
  });

  it('re-reads the keys a throttled profile batch declined to serve', async () => {
    setupScan(subRow());
    ddbMock
      .on(BatchGetItemCommand)
      .resolvesOnce({
        Responses: { UserInfoTable: [] },
        UnprocessedKeys: {
          UserInfoTable: { Keys: [{ pk: { S: 'USER#user-1' }, sk: { S: 'PROFILE' } }] },
        },
      })
      .resolvesOnce({ Responses: { UserInfoTable: [profileRow('user-1', EMAIL)] as never } });

    const summary = await syncAllContacts();

    expect(ddbMock.commandCalls(BatchGetItemCommand)).toHaveLength(2);
    expect(upsertCalls()).toEqual([{ userId: 'user-1', status: 'paying', email: EMAIL }]);
    expect(summary.missingEmail).toBe(0);
  });

  it('gates on the attempt marker, the staleness window and a disagreeing status', async () => {
    setupScan(subRow());

    await syncAllContacts();

    const input = scanInput();
    expect(input.FilterExpression).toContain('attribute_not_exists(hubspotSyncedAt)');
    expect(input.FilterExpression).toContain('hubspotSyncedAt < :staleBefore');
    expect(input.FilterExpression).toContain('hubspotSubscriptionStatus <> subscriptionStatus');
    expect(input.FilterExpression).toContain('attribute_not_exists(deletedAt)');
    // Gating on the success marker would re-select an unmatchable contact for ever.
    expect(input.FilterExpression).not.toContain('attribute_not_exists(hubspotSubscriptionStatus)');

    const staleBefore = Date.parse(input.ExpressionAttributeValues![':staleBefore']!.S!);
    expect(Date.now() - staleBefore).toBeCloseTo(30 * 24 * 60 * 60 * 1000, -4);
  });

  it('skips a leftover CUSTOMER# row rather than syncing its frozen status', async () => {
    setupScan(
      subRow({
        pk: 'CUSTOMER#user-9',
        orgId: 'org-9',
        userId: 'user-9',
        subscriptionStatus: SubscriptionStatus.Trialing,
      }),
      subRow(),
    );

    const summary = await syncAllContacts();

    expect(upsertCalls()).toEqual([{ userId: 'user-1', status: 'paying', email: EMAIL }]);
    expect(stampedKeys()).toEqual(['ORG#org-1']);
    expect(summary).toEqual({ ...NOTHING, total: 1, matched: 1 });
  });

  it('maps each stored status to its lifecycle value', async () => {
    setupScan(
      subRow({ pk: 'ORG#o1', orgId: 'o1', subscriptionStatus: SubscriptionStatus.Trialing }),
      subRow({ pk: 'ORG#o2', orgId: 'o2', subscriptionStatus: SubscriptionStatus.PastDue }),
      subRow({ pk: 'ORG#o3', orgId: 'o3', subscriptionStatus: SubscriptionStatus.GracePeriod }),
    );

    await syncAllContacts();

    expect(upsertCalls().map((args) => args.status)).toEqual([
      'trialing',
      'payment_failing',
      'lapsed',
    ]);
  });

  it('counts a HubSpot failure without aborting the rest of the run', async () => {
    setupScan(subRow(), subRow({ pk: 'ORG#org-2', orgId: 'org-2' }));
    mockUpsertContact.mockRejectedValueOnce(new Error('HubSpot 503')).mockResolvedValue('updated');

    const summary = await syncAllContacts();

    expect(summary).toEqual({ ...NOTHING, total: 2, writeFailed: 1, matched: 1 });
  });

  it('paginates the scan', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [subRow()] as never, LastEvaluatedKey: { pk: { S: 'x' } } })
      .resolvesOnce({ Items: [subRow({ pk: 'ORG#org-2', orgId: 'org-2' })] as never });

    const summary = await syncAllContacts();

    expect(summary.total).toBe(2);
  });

  it('emits the run summary as a single EMF datapoint', async () => {
    setupScan(subRow({ hubspotSubscriptionStatus: SubscriptionStatus.Trialing }));
    setupProfiles();

    await handler();

    const emitted = reportMetricMock.mock.calls
      .map(([event]) => event)
      .filter((e) => (e as MetricEvent).HubSpotContactSyncTotal !== undefined);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      HubSpotContactSyncTotal: 1,
      HubSpotContactMatched: 1,
      HubSpotContactUnmatched: 0,
      HubSpotContactWriteFailed: 0,
      HubSpotContactRepaired: 1,
      HubSpotContactSyncTruncated: 0,
      HubSpotContactMissingEmail: 1,
      HubSpotContactMissingUserId: 0,
    });
  });
});
