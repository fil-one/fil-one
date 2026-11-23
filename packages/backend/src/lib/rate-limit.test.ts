import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import { recordRateLimitedRequest } from './rate-limit.ts';

const NOW = new Date('2026-09-23T10:30:00Z');
const CUTOFF = { N: String(NOW.getTime() - 3_600_000) };
const TABLE = 'SomeTable';
const KEY = { pk: { S: 'THING#1' }, sk: { S: 'SOME_RATE' } };
const NAMES = { '#count': 'count', '#windowStart': 'windowStart' };
const MAX = 7;

function spendInput({ returnRowOnRefusal = false } = {}) {
  return {
    TableName: TABLE,
    Key: KEY,
    UpdateExpression: 'SET #count = #count + :one',
    ConditionExpression: '#windowStart > :cutoff AND #count < :max',
    ExpressionAttributeNames: NAMES,
    ExpressionAttributeValues: {
      ':one': { N: '1' },
      ':cutoff': CUTOFF,
      ':max': { N: String(MAX) },
    },
    ...(returnRowOnRefusal && { ReturnValuesOnConditionCheckFailure: 'ALL_OLD' }),
  };
}

const OPEN_WINDOW_INPUT = {
  TableName: TABLE,
  Key: KEY,
  UpdateExpression: 'SET #windowStart = :now, #count = :one',
  ConditionExpression: 'attribute_not_exists(#windowStart) OR #windowStart <= :cutoff',
  ExpressionAttributeNames: NAMES,
  ExpressionAttributeValues: {
    ':now': { N: String(NOW.getTime()) },
    ':one': { N: '1' },
    ':cutoff': CUTOFF,
  },
};

const conditionFailed = (item?: Record<string, unknown>) =>
  new ConditionalCheckFailedException({ message: 'no', $metadata: {}, Item: item as never });

function sentInputs() {
  return ddbMock.commandCalls(UpdateItemCommand).map((call) => call.args[0].input);
}

function take() {
  return recordRateLimitedRequest({ tableName: TABLE, key: KEY, max: MAX, now: NOW });
}

describe('recordRateLimitedRequest', () => {
  beforeEach(() => ddbMock.reset());

  it('spends one from an open window under the cap', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    expect(await take()).toStrictEqual({ allowed: true });
    expect(sentInputs()).toEqual([spendInput()]);
  });

  it('refuses, and spends nothing, at the cap in an open window', async () => {
    ddbMock.on(UpdateItemCommand).rejects(conditionFailed());

    expect(await take()).toMatchObject({ allowed: false });
    expect(sentInputs()).toEqual([
      spendInput(),
      OPEN_WINDOW_INPUT,
      spendInput({ returnRowOnRefusal: true }),
    ]);
  });

  it('tells a refused call to retry an hour after its window opened', async () => {
    const windowStart = NOW.getTime() - 20 * 60 * 1000;
    ddbMock
      .on(UpdateItemCommand)
      .rejectsOnce(conditionFailed())
      .rejectsOnce(conditionFailed())
      .rejects(conditionFailed({ windowStart: { N: String(windowStart) }, count: { N: '7' } }));

    expect(await take()).toStrictEqual({
      allowed: false,
      retryAt: new Date(windowStart + 60 * 60 * 1000),
    });
  });

  // A passed window and a missing row both fail the spend and pass the reset.
  it('opens a new window at now with a count of 1 once the old one has passed, or on first use', async () => {
    ddbMock.on(UpdateItemCommand).rejectsOnce(conditionFailed()).resolves({});

    expect(await take()).toStrictEqual({ allowed: true });
    expect(sentInputs()).toEqual([spendInput(), OPEN_WINDOW_INPUT]);
  });

  it('spends from a window a concurrent call opened first', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .rejectsOnce(conditionFailed())
      .rejectsOnce(conditionFailed())
      .resolves({});

    expect(await take()).toStrictEqual({ allowed: true });
    expect(sentInputs()).toEqual([
      spendInput(),
      OPEN_WINDOW_INPUT,
      spendInput({ returnRowOnRefusal: true }),
    ]);
  });

  it('lets any other failure through to the caller', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('Service unavailable'));

    await expect(take()).rejects.toThrow('Service unavailable');
    expect(sentInputs()).toEqual([spendInput()]);
  });
});
