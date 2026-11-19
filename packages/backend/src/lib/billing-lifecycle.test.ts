import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { buildBillingLifecycleDetail, captureBillingLifecycle } from './billing-lifecycle.ts';

const ddb = mockClient(DynamoDBClient);
const created = 1795100000;
function trial() {
  return {
    id: 'evt_any-trial',
    type: 'customer.subscription.created',
    created,
    data: {
      object: {
        object: 'subscription',
        status: 'trialing',
        trial_start: created - 10,
        metadata: { orgId: 'any-org', userId: 'private-user' },
      },
    },
  };
}
function invoice(type = 'invoice.payment_succeeded') {
  return {
    id: 'evt_any-invoice',
    type,
    created,
    data: {
      object: {
        object: 'invoice',
        status: 'paid',
        amount_paid: 100,
        amount_due: 100,
        parent: {
          type: 'subscription_details',
          subscription_details: { metadata: { orgId: 'any-org' } },
        },
      },
    },
  };
}

beforeEach(() => {
  ddb.reset();
  vi.stubEnv('FILONE_LIFECYCLE_BILLING_OUTBOX_TABLE', 'any-billing-outbox');
});
afterEach(() => vi.unstubAllEnvs());

describe('verified billing lifecycle outcomes', () => {
  it('records original trial occurrence and only opaque Organization/event metadata', () => {
    expect(buildBillingLifecycleDetail(trial())).toStrictEqual({
      schema_version: 1,
      event_id: expect.stringMatching(/^billing_[a-f0-9]{64}$/),
      event_type: 'trial.started',
      occurred_at: new Date((created - 10) * 1000).toISOString(),
      organization_id: 'any-org',
    });
  });

  it.each([
    ['invoice.payment_succeeded', 'payment.succeeded'],
    ['invoice.payment_failed', 'payment.failed'],
  ])('records %s from the original invoice metadata and event occurrence', (input, expected) => {
    expect(buildBillingLifecycleDetail(invoice(input))).toStrictEqual({
      schema_version: 1,
      event_id: expect.stringMatching(/^billing_[a-f0-9]{64}$/),
      event_type: expected,
      occurred_at: new Date(created * 1000).toISOString(),
      organization_id: 'any-org',
    });
  });

  it.each([0, -1, NaN, Infinity, 0.5])(
    'does not treat amount_paid %s as evidence of payment',
    (amount) => {
      const event = invoice();
      event.data.object.amount_paid = amount;
      expect(buildBillingLifecycleDetail(event)).toBeUndefined();
    },
  );

  it('does not treat an unpaid invoice or an unrelated update as successful payment', () => {
    const event = invoice();
    event.data.object.status = 'open';
    expect(buildBillingLifecycleDetail(event)).toBeUndefined();
    expect(buildBillingLifecycleDetail({ ...event, type: 'customer.updated' })).toBeUndefined();
  });

  it('rejects missing Organization metadata instead of inventing a mapping from a current snapshot', () => {
    const event = invoice();
    event.data.object.parent.subscription_details.metadata.orgId = '';
    expect(() => buildBillingLifecycleDetail(event)).toThrow(
      'Billing lifecycle Organization metadata unavailable',
    );
  });

  it('rejects conflicting invoice and immutable subscription Organization metadata', () => {
    const event = invoice();
    expect(() =>
      buildBillingLifecycleDetail({
        ...event,
        data: { object: { ...event.data.object, metadata: { orgId: 'other-org' } } },
      }),
    ).toThrow('Billing lifecycle Organization metadata conflicts');
  });

  it('rejects an email address in an Organization identifier', () => {
    const event = trial();
    event.data.object.metadata.orgId = 'private@example.org';
    expect(() => buildBillingLifecycleDetail(event)).toThrow(
      'Billing lifecycle Organization metadata unavailable',
    );
  });

  it('has no effect while billing capture is disabled', async () => {
    vi.stubEnv('FILONE_LIFECYCLE_BILLING_OUTBOX_TABLE', '');
    await captureBillingLifecycle({ malformed: true });
    expect(ddb.calls()).toStrictEqual([]);
  });

  it('keeps replay identity and fingerprint stable without retaining Stripe/card/contact identifiers', async () => {
    ddb.on(PutItemCommand).resolves({});
    const event = invoice();
    await captureBillingLifecycle(event);
    await captureBillingLifecycle(event);
    const writes = ddb.commandCalls(PutItemCommand).map((call) => call.args[0].input);
    const first = unmarshall(writes[0].Item!);
    const retry = unmarshall(writes[1].Item!);
    expect(first.detail).toStrictEqual(retry.detail);
    expect(first.fingerprint).toBe(retry.fingerprint);
    expect(writes[0]).toMatchObject({
      TableName: 'any-billing-outbox',
      ConditionExpression: 'attribute_not_exists(event_id) OR fingerprint = :fingerprint',
      ExpressionAttributeValues: { ':fingerprint': { S: first.fingerprint } },
    });
    expect(Object.keys(first).sort()).toStrictEqual([
      'detail',
      'event_id',
      'expires_at',
      'fingerprint',
    ]);
  });

  it('fails retryably with a sanitized error when durable storage refuses the outcome', async () => {
    ddb.on(PutItemCommand).rejects(new Error('private transport payload'));
    await expect(captureBillingLifecycle(invoice())).rejects.toThrow(
      'Billing lifecycle outbox unavailable',
    );
  });
});
