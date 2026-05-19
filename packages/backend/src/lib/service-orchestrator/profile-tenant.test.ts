import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  advanceTenantStatus,
  readTenantAttrs,
  recordTenantSetupFailure,
} from './profile-tenant.js';

const AURORA_ATTRS = {
  statusAttr: 'setupStatus',
  tenantIdAttr: 'auroraTenantId',
  failureCountAttr: 'setupFailureCount',
};

const FTH_ATTRS = {
  statusAttr: 'fthSetupStatus',
  tenantIdAttr: 'fthTenantId',
  failureCountAttr: 'fthSetupFailureCount',
};

describe('profile-tenant readTenantAttrs', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('returns null when no PROFILE row exists', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    const result = await readTenantAttrs('org-1', AURORA_ATTRS);
    expect(result).toBeNull();
  });

  it('reads Aurora-shaped attributes', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: 'ORG#org-1' },
        sk: { S: 'PROFILE' },
        name: { S: 'Acme' },
        auroraTenantId: { S: 'aurora-t-1' },
        setupStatus: { S: 'AURORA_S3_ACCESS_KEY_CREATED' },
        setupFailureCount: { N: '2' },
      },
    });
    const result = await readTenantAttrs('org-1', AURORA_ATTRS);
    expect(result).toEqual({
      tenantId: 'aurora-t-1',
      setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
      setupFailureCount: 2,
      orgName: 'Acme',
    });
  });

  it('reads FTH-shaped attributes from the same PROFILE row', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: 'ORG#org-1' },
        sk: { S: 'PROFILE' },
        fthTenantId: { S: 'fth-c-1' },
        fthSetupStatus: { S: 'FTH_ACCESS_KEY_CREATED' },
        fthSetupFailureCount: { N: '0' },
      },
    });
    const result = await readTenantAttrs('org-1', FTH_ATTRS);
    expect(result).toEqual({
      tenantId: 'fth-c-1',
      setupStatus: 'FTH_ACCESS_KEY_CREATED',
      setupFailureCount: 0,
      orgName: undefined,
    });
  });

  it('returns undefined for attributes that are not yet set', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' }, name: { S: 'Acme' } },
    });
    const result = await readTenantAttrs('org-1', AURORA_ATTRS);
    expect(result).toEqual({
      tenantId: undefined,
      setupStatus: undefined,
      setupFailureCount: undefined,
      orgName: 'Acme',
    });
  });
});

describe('profile-tenant advanceTenantStatus', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it("returns 'wrote' on a successful conditional update", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    const result = await advanceTenantStatus({
      orgId: 'org-1',
      statusAttr: 'setupStatus',
      expected: 'FILONE_ORG_CREATED',
      next: 'AURORA_TENANT_CREATED',
    });
    expect(result).toBe('wrote');
  });

  it("returns 'lost-race' on ConditionalCheckFailedException", async () => {
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} }));
    const result = await advanceTenantStatus({
      orgId: 'org-1',
      statusAttr: 'setupStatus',
      expected: 'FILONE_ORG_CREATED',
      next: 'AURORA_TENANT_CREATED',
    });
    expect(result).toBe('lost-race');
  });

  it('rethrows non-conditional errors', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));
    await expect(
      advanceTenantStatus({
        orgId: 'org-1',
        statusAttr: 'setupStatus',
        expected: 'FILONE_ORG_CREATED',
        next: 'AURORA_TENANT_CREATED',
      }),
    ).rejects.toThrow('throttled');
  });

  it('writes the tenant id when provided', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    await advanceTenantStatus({
      orgId: 'org-1',
      statusAttr: 'setupStatus',
      expected: 'FILONE_ORG_CREATED',
      next: 'AURORA_TENANT_CREATED',
      writeTenantIdAttr: 'auroraTenantId',
      writeTenantId: 'aurora-t-1',
    });
    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.UpdateExpression).toContain('auroraTenantId = :tid');
    expect(calls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
      ':tid': { S: 'aurora-t-1' },
      ':expected': { S: 'FILONE_ORG_CREATED' },
      ':status': { S: 'AURORA_TENANT_CREATED' },
    });
  });
});

describe('profile-tenant recordTenantSetupFailure', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('returns the new counter value', async () => {
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: { setupFailureCount: { N: '3' } } });
    const value = await recordTenantSetupFailure('org-1', AURORA_ATTRS);
    expect(value).toBe(3);
  });

  it('returns 0 when the response has no Attributes', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    const value = await recordTenantSetupFailure('org-1', AURORA_ATTRS);
    expect(value).toBe(0);
  });
});
