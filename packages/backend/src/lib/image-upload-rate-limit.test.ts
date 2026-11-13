import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import {
  takeAvatarPresign,
  takeOrgLogoPresign,
  IMAGE_UPLOAD_PRESIGNS_PER_HOUR,
} from './image-upload-rate-limit.ts';

const NOW = new Date('2026-09-23T10:30:00Z');
const CUTOFF = { N: String(NOW.getTime() - 3_600_000) };
const NAMES = { '#count': 'count', '#windowStart': 'windowStart' };

function spendInput(tableName: string, key: object) {
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

function sentInputs() {
  return ddbMock.commandCalls(UpdateItemCommand).map((call) => call.args[0].input);
}

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
