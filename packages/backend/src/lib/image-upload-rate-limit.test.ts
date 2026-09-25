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
  takeImageUploadPresign,
  IMAGE_UPLOAD_PRESIGNS_PER_HOUR,
} from './image-upload-rate-limit.ts';

describe('takeImageUploadPresign', () => {
  beforeEach(() => ddbMock.reset());

  it('counts the call against the caller for the current hour', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    const now = new Date('2026-09-23T10:30:00Z');

    expect(await takeImageUploadPresign('user-1', now)).toBe(true);

    const input = ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.TableName).toBe('ImageUploadRateLimitTable');
    expect(input.Key).toEqual({
      pk: { S: `USER#user-1#HOUR#${Math.floor(now.getTime() / 3_600_000)}` },
    });
    // Incremented only while under the limit, so a refusal spends nothing.
    expect(input.ConditionExpression).toBe('attribute_not_exists(#count) OR #count < :max');
    expect(input.ExpressionAttributeValues?.[':max']).toEqual({
      N: String(IMAGE_UPLOAD_PRESIGNS_PER_HOUR),
    });
  });

  it('refuses once the hour is spent', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'limit', $metadata: {} }));

    expect(await takeImageUploadPresign('user-1')).toBe(false);
  });

  it('lets any other failure through to the caller', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('Service unavailable'));

    await expect(takeImageUploadPresign('user-1')).rejects.toThrow('Service unavailable');
  });
});
