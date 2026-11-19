import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';
vi.mock('sst', () => sstResourceMock());
import {
  hashLifecycleCustomer,
  readLifecycleCustomerBinding,
  recordLifecycleCustomerBinding,
} from './lifecycle-customer-binding.ts';

const ddb = mockClient(DynamoDBClient);
const customer = 'cus_any-customer';
const getNow = () => Math.floor(Date.now() / 1000);
function createRow() {
  return {
    customer_hash: { S: hashLifecycleCustomer(customer) },
    organization_id: { S: 'any-org' },
    bound_at_epoch: { N: String(getNow() - 60) },
    expires_at: { N: String(getNow() + 3600) },
  };
}
beforeEach(() => {
  ddb.reset();
  vi.stubEnv('FILONE_LIFECYCLE_CUSTOMER_BINDINGS_TABLE', 'any-bindings');
});
afterEach(() => vi.unstubAllEnvs());

describe('authoritative lifecycle customer bindings', () => {
  it('makes no request while binding capture is disabled', async () => {
    vi.stubEnv('FILONE_LIFECYCLE_CUSTOMER_BINDINGS_TABLE', '');
    await recordLifecycleCustomerBinding({ orgId: 'any-org', customerId: customer });
    expect(await readLifecycleCustomerBinding(customer, getNow())).toStrictEqual({
      status: 'disabled',
    });
    expect(ddb.calls()).toStrictEqual([]);
  });

  it('atomically guards the current server customer and Organization while binding only its digest', async () => {
    ddb.on(TransactWriteItemsCommand).resolves({});
    await recordLifecycleCustomerBinding({ orgId: 'any-org', customerId: customer });
    const items = ddb.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems!;
    expect(items[0].ConditionCheck).toMatchObject({
      TableName: 'BillingTable',
      Key: { pk: { S: 'ORG#any-org' }, sk: { S: 'SUBSCRIPTION' } },
      ConditionExpression:
        'attribute_exists(pk) AND stripeCustomerId = :customer AND attribute_not_exists(deletedAt)',
      ExpressionAttributeValues: { ':customer': { S: customer } },
    });
    expect(items[1].ConditionCheck).toMatchObject({
      TableName: 'UserInfoTable',
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleting)',
    });
    expect(items[2].Update).toMatchObject({
      TableName: 'any-bindings',
      Key: { customer_hash: { S: hashLifecycleCustomer(customer) } },
      ConditionExpression: 'attribute_not_exists(customer_hash) OR #org = :org',
      UpdateExpression:
        'SET #org = if_not_exists(#org, :org), #bound = if_not_exists(#bound, :now), #expires = :expires',
      ExpressionAttributeValues: { ':org': { S: 'any-org' } },
    });
    expect(JSON.stringify(items[2])).not.toContain(customer);
  });

  it('refuses a conflicting immutable Organization instead of silently reassigning its Customer', async () => {
    ddb.on(TransactWriteItemsCommand).rejects(new Error('conditional binding conflict'));
    await expect(
      recordLifecycleCustomerBinding({ orgId: 'other-org', customerId: customer }),
    ).rejects.toThrow('Lifecycle customer binding unavailable');
    expect(ddb.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });

  it('resolves an existing binding using a strong exact-key read', async () => {
    ddb.on(GetItemCommand).resolves({ Item: createRow() });
    expect(await readLifecycleCustomerBinding(customer, getNow())).toStrictEqual({
      status: 'bound',
      organizationId: 'any-org',
    });
    expect(ddb.commandCalls(GetItemCommand)[0].args[0].input).toMatchObject({
      TableName: 'any-bindings',
      Key: { customer_hash: { S: hashLifecycleCustomer(customer) } },
      ConsistentRead: true,
    });
  });

  it('reports an unbound customer as outside-or-unknown cohort without inventing its Organization', async () => {
    ddb.on(GetItemCommand).resolves({});
    expect(await readLifecycleCustomerBinding(customer, getNow())).toStrictEqual({
      status: 'unbound',
    });
  });

  it('excludes an expired binding before asynchronous DynamoDB TTL deletion', async () => {
    ddb
      .on(GetItemCommand)
      .resolves({ Item: { ...createRow(), expires_at: { N: String(getNow() - 1) } } });
    expect(await readLifecycleCustomerBinding(customer, getNow())).toStrictEqual({
      status: 'expired',
    });
  });

  it('does not retroactively assign an older event after a binding was recreated', async () => {
    ddb
      .on(GetItemCommand)
      .resolves({ Item: { ...createRow(), bound_at_epoch: { N: String(getNow() + 1) } } });
    expect(await readLifecycleCustomerBinding(customer, getNow())).toStrictEqual({
      status: 'predates-binding',
    });
  });

  it('fails retryably on unavailable storage instead of pretending the customer is unbound', async () => {
    ddb.on(GetItemCommand).rejects(new Error('private read context'));
    await expect(readLifecycleCustomerBinding(customer, getNow())).rejects.toThrow(
      'Lifecycle customer binding read unavailable',
    );
  });

  it('rejects a corrupt binding without using a mutable Customer lookup', async () => {
    ddb
      .on(GetItemCommand)
      .resolves({ Item: { ...createRow(), organization_id: { S: 'private@example.org' } } });
    await expect(readLifecycleCustomerBinding(customer, getNow())).rejects.toThrow(
      'Lifecycle customer binding is invalid',
    );
  });
});
