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

import {
  takeAvatarPresign,
  takeHourlyAllowance,
  takeOrgLogoPresign,
  IMAGE_UPLOAD_PRESIGNS_PER_HOUR,
} from './image-upload-rate-limit.ts';

const NOW = new Date('2026-09-23T10:30:00Z');
const CUTOFF = { N: String(NOW.getTime() - 3_600_000) };
const TABLE = 'SomeTable';
const KEY = { pk: { S: 'THING#1' }, sk: { S: 'SOME_RATE' } };
const NAMES = { '#count': 'count', '#windowStart': 'windowStart' };

function spendInput(tableName = TABLE, key: object = KEY) {
  return {
    TableName: tableName,
    Key: key,
    UpdateExpression: 'SET #count = #count + :one',
    ConditionExpression: '#windowStart > :cutoff AND #count < :max',
    ExpressionAttributeNames: NAMES,
    ExpressionAttributeValues: {
      ':one': { N: '1' },
      ':cutoff': CUTOFF,
      ':max': { N: String(IMAGE_UPLOAD_PRESIGNS_PER_HOUR) },
    },
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

const conditionFailed = () => new ConditionalCheckFailedException({ message: 'no', $metadata: {} });

function sentInputs() {
  return ddbMock.commandCalls(UpdateItemCommand).map((call) => call.args[0].input);
}

function take() {
  return takeHourlyAllowance({ tableName: TABLE, key: KEY, now: NOW });
}

describe('takeHourlyAllowance', () => {
  beforeEach(() => ddbMock.reset());

  it('spends one from an open window under the cap', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    expect(await take()).toBe(true);
    expect(sentInputs()).toEqual([spendInput()]);
  });

  it('refuses, and spends nothing, at the cap in an open window', async () => {
    ddbMock.on(UpdateItemCommand).rejects(conditionFailed());

    expect(await take()).toBe(false);
    expect(sentInputs()).toEqual([spendInput(), OPEN_WINDOW_INPUT, spendInput()]);
  });

  // A passed window and a missing row both fail the spend and pass the reset.
  it('opens a new window at now with a count of 1 once the old one has passed, or on first use', async () => {
    ddbMock.on(UpdateItemCommand).rejectsOnce(conditionFailed()).resolves({});

    expect(await take()).toBe(true);
    expect(sentInputs()).toEqual([spendInput(), OPEN_WINDOW_INPUT]);
  });

  it('spends from a window a concurrent call opened first', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .rejectsOnce(conditionFailed())
      .rejectsOnce(conditionFailed())
      .resolves({});

    expect(await take()).toBe(true);
    expect(sentInputs()).toEqual([spendInput(), OPEN_WINDOW_INPUT, spendInput()]);
  });

  it('lets any other failure through to the caller', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('Service unavailable'));

    await expect(take()).rejects.toThrow('Service unavailable');
    expect(sentInputs()).toEqual([spendInput()]);
  });
});

describe('takeOrgLogoPresign', () => {
  beforeEach(() => ddbMock.reset());

  it("counts on the org's row in OrgTable", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    expect(await takeOrgLogoPresign('org-1', NOW)).toBe(true);
    expect(sentInputs()).toEqual([
      spendInput('OrgTable', { pk: { S: 'ORG#org-1' }, sk: { S: 'LOGO_UPLOAD_RATE' } }),
    ]);
  });
});

describe('takeAvatarPresign', () => {
  beforeEach(() => ddbMock.reset());

  it("counts on the user's row in UserInfoTable", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    expect(await takeAvatarPresign('user-1', NOW)).toBe(true);
    expect(sentInputs()).toEqual([
      spendInput('UserInfoTable', { pk: { S: 'USER#user-1' }, sk: { S: 'AVATAR_UPLOAD_RATE' } }),
    ]);
  });
});
