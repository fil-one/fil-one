import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';
import { expectErrorResponse } from '../test/assert-helpers.js';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { isAllowlisted, hasRagAccess, ragAccessMiddleware } from './rag-access.js';

describe('isAllowlisted', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('reads ALLOWLIST#<email>/ALLOWLIST from UserInfoTable via a single GetItemCommand', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: {} });

    await isAllowlisted('alice@example.com');

    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(GetItemCommand)[0]?.args[0].input).toEqual({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'ALLOWLIST#alice@example.com' }, sk: { S: 'ALLOWLIST' } },
    });
  });

  it('returns true when the allowlist row exists', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: { pk: { S: 'ALLOWLIST#alice@example.com' }, sk: { S: 'ALLOWLIST' } },
    });

    expect(await isAllowlisted('alice@example.com')).toBe(true);
  });

  it('returns false when no allowlist row exists', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    expect(await isAllowlisted('alice@example.com')).toBe(false);
  });

  it('lowercases the email before building the key (case-insensitive match)', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: {} });

    await isAllowlisted('Alice@Example.COM');

    expect(ddbMock.commandCalls(GetItemCommand)[0]?.args[0].input).toEqual({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'ALLOWLIST#alice@example.com' }, sk: { S: 'ALLOWLIST' } },
    });
  });

  it('matches case-insensitively: a hit on the lowercased key resolves a mixed-case email', async () => {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: 'ALLOWLIST#alice@example.com' }, sk: { S: 'ALLOWLIST' } },
      })
      .resolves({ Item: { pk: { S: 'ALLOWLIST#alice@example.com' }, sk: { S: 'ALLOWLIST' } } });

    expect(await isAllowlisted('ALICE@EXAMPLE.COM')).toBe(true);
  });
});

describe('hasRagAccess', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('returns false for an undefined email without a DynamoDB lookup', async () => {
    expect(await hasRagAccess(undefined)).toBe(false);
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it('returns true for a Foundation email without a DynamoDB lookup', async () => {
    expect(await hasRagAccess('alice@fil.org')).toBe(true);
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it('returns true for an allowlisted email', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: { pk: { S: 'ALLOWLIST#bob@example.com' }, sk: { S: 'ALLOWLIST' } },
    });

    expect(await hasRagAccess('bob@example.com')).toBe(true);
  });

  it('returns false for a non-Foundation, non-allowlisted email', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    expect(await hasRagAccess('eve@example.com')).toBe(false);
  });
});

describe('ragAccessMiddleware', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('passes through (returns no response) for a verified @fil.org email without a DynamoDB lookup', async () => {
    const { before } = ragAccessMiddleware();
    const result = await before(
      buildMiddyRequest(
        buildEvent({
          userInfo: {
            userId: 'user-1',
            orgId: 'org-1',
            email: 'alice@fil.org',
            emailVerified: true,
          },
        }),
      ),
    );

    expect(result).toBeUndefined();
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it('passes through (returns no response) for a verified allowlisted email', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: { pk: { S: 'ALLOWLIST#bob@example.com' }, sk: { S: 'ALLOWLIST' } },
    });

    const { before } = ragAccessMiddleware();
    const result = await before(
      buildMiddyRequest(
        buildEvent({
          userInfo: {
            userId: 'user-1',
            orgId: 'org-1',
            email: 'bob@example.com',
            emailVerified: true,
          },
        }),
      ),
    );

    expect(result).toBeUndefined();
  });

  it('returns a 403 when neither @fil.org nor allowlisted', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    const { before } = ragAccessMiddleware();
    const result = await before(
      buildMiddyRequest(
        buildEvent({
          userInfo: {
            userId: 'user-1',
            orgId: 'org-1',
            email: 'eve@example.com',
            emailVerified: true,
          },
        }),
      ),
    );

    expectErrorResponse(result, 403, { message: 'You do not have access to this feature.' });
  });

  it('returns a 403 for an unverified email AND performs no DynamoDB lookup', async () => {
    // Even though an allowlist row would exist, an unverified email must be denied
    // without reading the allowlist (verified-only).
    ddbMock.on(GetItemCommand).resolves({
      Item: { pk: { S: 'ALLOWLIST#bob@example.com' }, sk: { S: 'ALLOWLIST' } },
    });

    const { before } = ragAccessMiddleware();
    const result = await before(
      buildMiddyRequest(
        buildEvent({
          userInfo: {
            userId: 'user-1',
            orgId: 'org-1',
            email: 'bob@example.com',
            emailVerified: false,
          },
        }),
      ),
    );

    expectErrorResponse(result, 403, { message: 'You do not have access to this feature.' });
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it('returns a 403 for a missing email AND performs no DynamoDB lookup', async () => {
    const { before } = ragAccessMiddleware();
    const result = await before(
      buildMiddyRequest(
        buildEvent({
          userInfo: {
            userId: 'user-1',
            orgId: 'org-1',
            email: undefined,
            emailVerified: true,
          },
        }),
      ),
    );

    expectErrorResponse(result, 403, { message: 'You do not have access to this feature.' });
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });
});
