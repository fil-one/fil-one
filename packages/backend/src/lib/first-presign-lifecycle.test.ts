import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());
import { recordFirstPresignLifecycle } from './first-presign-lifecycle.ts';

const ddb = mockClient(DynamoDBClient);
const capturedAt = '2026-11-19T12:00:00.000Z';
const profile = () => ({
  pk: { S: 'ORG#any-org' },
  sk: { S: 'PROFILE' },
  lifecycleCaptureStartedAt: { S: capturedAt },
  lifecycleCaptureEpoch: { S: 'any-epoch' },
  auroraTenantId: { S: 'any-tenant' },
});
const input = () => ({
  orgId: 'any-org',
  provider: 'aurora',
  tenantId: 'any-tenant',
  profile: profile(),
});
const invalidMarkers: Record<string, AttributeValue>[] = [
  { deleting: { BOOL: true } },
  { auroraTenantId: { S: 'other-tenant' } },
  { lifecycleCaptureStartedAt: { S: 'different-cohort' } },
  { lifecycleCaptureEpoch: { S: 'different-epoch' } },
];

beforeEach(() => {
  ddb.reset();
  vi.stubEnv('FILONE_LIFECYCLE_OUTBOX_TABLE', 'any-outbox');
  vi.stubEnv('FILONE_LIFECYCLE_FIRST_MILESTONE_EPOCH', 'any-epoch');
});
afterEach(() => vi.unstubAllEnvs());

describe('first presign lifecycle', () => {
  it('makes no writes when capture is disabled', async () => {
    vi.stubEnv('FILONE_LIFECYCLE_OUTBOX_TABLE', '');
    await recordFirstPresignLifecycle(input());
    expect(ddb.calls()).toStrictEqual([]);
  });

  it('does not invent a first issuance for an Organization outside the captured signup cohort', async () => {
    await recordFirstPresignLifecycle({
      ...input(),
      profile: { auroraTenantId: { S: 'any-tenant' } },
    });
    expect(ddb.calls()).toStrictEqual([]);
  });

  it('does not relabel an earlier cohort after a capture epoch changes', async () => {
    vi.stubEnv('FILONE_LIFECYCLE_FIRST_MILESTONE_EPOCH', 'new-epoch');
    await recordFirstPresignLifecycle(input());
    expect(ddb.calls()).toStrictEqual([]);
  });

  it('makes no writes when first-event capture has no active epoch', async () => {
    vi.stubEnv('FILONE_LIFECYCLE_FIRST_MILESTONE_EPOCH', '');
    await recordFirstPresignLifecycle(input());
    expect(ddb.calls()).toStrictEqual([]);
  });

  it('does not add a read or write after the already-loaded profile has the first marker', async () => {
    await recordFirstPresignLifecycle({
      ...input(),
      profile: { ...profile(), lifecycleFirstPresignEventId: { S: 'any-first-event' } },
    });
    expect(ddb.calls()).toStrictEqual([]);
  });

  it('commits the first marker with a trusted tenant-bound outbox event and deletion fence', async () => {
    ddb.on(TransactWriteItemsCommand).resolves({});
    await recordFirstPresignLifecycle(input());
    const transaction = ddb.commandCalls(TransactWriteItemsCommand)[0].args[0].input;
    const [marker, event] = transaction.TransactItems!;
    const row = unmarshall(event.Put!.Item!);
    expect(row.detail).toStrictEqual({
      schema_version: 1,
      event_id: row.event_id,
      event_type: 'presign.first_issued',
      occurred_at: expect.any(String),
      organization_id: 'any-org',
      observed_tenant: { sp: 'aurora', id: 'any-tenant' },
    });
    expect(marker.Update).toMatchObject({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'ORG#any-org' }, sk: { S: 'PROFILE' } },
      ConditionExpression: expect.stringContaining('attribute_not_exists(deleting)'),
      ExpressionAttributeNames: {
        '#first': 'lifecycleFirstPresignEventId',
        '#tenant': 'auroraTenantId',
      },
      ExpressionAttributeValues: {
        ':event': { S: row.event_id },
        ':captured': { S: capturedAt },
        ':epoch': { S: 'any-epoch' },
        ':tenant': { S: 'any-tenant' },
      },
    });
    expect(marker.Update!.ConditionExpression).toContain(
      'lifecycleCaptureStartedAt = :captured AND lifecycleCaptureEpoch = :epoch AND #tenant = :tenant',
    );
    expect(marker.Update!.ConditionExpression).toContain('attribute_not_exists(#first)');
  });

  it('refuses a mismatched provider tenant before storage access', async () => {
    await expect(
      recordFirstPresignLifecycle({ ...input(), tenantId: 'wrong-tenant' }),
    ).rejects.toThrow('Lifecycle tenant mapping is unavailable');
    expect(ddb.calls()).toStrictEqual([]);
  });

  it('accepts an atomic first marker from a concurrent issuer without rewriting the outbox', async () => {
    ddb.on(TransactWriteItemsCommand).callsFake((transaction) => {
      const eventId = transaction.TransactItems[1].Put.Item.event_id.S;
      throw new TransactionCanceledException({
        $metadata: {},
        message: 'concurrent first',
        CancellationReasons: [
          {
            Code: 'ConditionalCheckFailed',
            Item: { ...profile(), lifecycleFirstPresignEventId: { S: eventId } },
          },
          { Code: 'ConditionalCheckFailed' },
        ],
      });
    });
    await expect(recordFirstPresignLifecycle(input())).resolves.toBeUndefined();
    expect(ddb.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });

  it.each(invalidMarkers)(
    'does not mistake a failed identity/deletion fence for concurrent success: %j',
    async (changed) => {
      ddb.on(TransactWriteItemsCommand).callsFake((transaction) => {
        const eventId = transaction.TransactItems[1].Put.Item.event_id.S;
        throw new TransactionCanceledException({
          $metadata: {},
          message: 'private request context',
          CancellationReasons: [
            {
              Code: 'ConditionalCheckFailed',
              Item: { ...profile(), lifecycleFirstPresignEventId: { S: eventId }, ...changed },
            },
            { Code: 'ConditionalCheckFailed' },
          ],
        });
      });
      await expect(recordFirstPresignLifecycle(input())).rejects.toThrow(
        'Lifecycle first-issuance commit unavailable',
      );
    },
  );

  it('returns a sanitized failure when storage is unavailable', async () => {
    ddb.on(TransactWriteItemsCommand).rejects(new Error('private transport context'));
    await expect(recordFirstPresignLifecycle(input())).rejects.toThrow(
      'Lifecycle first-issuance commit unavailable',
    );
  });
});
