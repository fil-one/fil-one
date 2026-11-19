import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';
vi.mock('sst', () => sstResourceMock());
import { hashLifecycleCustomer } from './lifecycle-customer-binding.ts';
import { captureBillingLifecycle } from './billing-lifecycle.ts';

const ddb = mockClient(DynamoDBClient);
const customer = 'cus_any-customer';
const getNow = () => Math.floor(Date.now() / 1000);
function createEvent() {
  return {
    id: 'evt_any-attachment',
    type: 'payment_method.attached',
    created: getNow(),
    data: {
      object: {
        object: 'payment_method',
        customer,
        id: 'pm_private',
        card: { fingerprint: 'private-fingerprint' },
        metadata: { orgId: 'untrusted-org' },
      },
    },
  };
}
function createBinding() {
  return {
    customer_hash: { S: hashLifecycleCustomer(customer) },
    organization_id: { S: 'trusted-org' },
    bound_at_epoch: { N: String(getNow() - 60) },
    expires_at: { N: String(getNow() + 60) },
  };
}
beforeEach(() => {
  ddb.reset();
  vi.stubEnv('FILONE_LIFECYCLE_BILLING_OUTBOX_TABLE', 'any-outbox');
  vi.stubEnv('FILONE_LIFECYCLE_CUSTOMER_BINDINGS_TABLE', 'any-bindings');
  ddb.on(PutItemCommand).resolves({});
});
afterEach(() => vi.unstubAllEnvs());

describe('original attachment lifecycle evidence', () => {
  it('uses the immutable server binding and retains no raw Customer/card/method data', async () => {
    const original = createEvent();
    ddb.on(GetItemCommand).resolves({ Item: createBinding() });
    await captureBillingLifecycle(original);
    const item = unmarshall(ddb.commandCalls(PutItemCommand)[0].args[0].input.Item!);
    expect(item.detail).toStrictEqual({
      schema_version: 1,
      event_id: expect.stringMatching(/^billing_[a-f0-9]{64}$/),
      event_type: 'payment.method_added',
      occurred_at: new Date(original.created * 1000).toISOString(),
      organization_id: 'trusted-org',
    });
    expect(JSON.stringify(item)).not.toContain(customer);
    expect(JSON.stringify(item)).not.toContain('private');
    expect(JSON.stringify(item)).not.toContain('untrusted-org');
  });

  it('does not stall an unrelated unbound customer or fabricate a lifecycle event', async () => {
    ddb.on(GetItemCommand).resolves({});
    await expect(captureBillingLifecycle(createEvent())).resolves.toBeUndefined();
    expect(ddb.commandCalls(PutItemCommand)).toStrictEqual([]);
  });

  it('keeps a binding-read outage retryable instead of acknowledging missing evidence', async () => {
    ddb.on(GetItemCommand).rejects(new Error('private SDK context'));
    await expect(captureBillingLifecycle(createEvent())).rejects.toThrow(
      'Lifecycle customer binding read unavailable',
    );
    expect(ddb.commandCalls(PutItemCommand)).toStrictEqual([]);
  });

  it('does not count a successful reused SetupIntent as a new attachment', async () => {
    await captureBillingLifecycle({ ...createEvent(), type: 'setup_intent.succeeded' });
    expect(ddb.calls()).toStrictEqual([]);
  });
});
