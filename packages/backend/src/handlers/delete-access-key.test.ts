import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, DeleteItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const auroraIsTenantReady = vi.fn();
const auroraDeleteAccessKey = vi.fn();
const fthIsTenantReady = vi.fn();
const fthDeleteAccessKey = vi.fn();
const mockGetOrchestratorForRegion = vi.fn();

const auroraMock = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: (...args: unknown[]) => auroraIsTenantReady(...args),
  deleteAccessKey: (...args: unknown[]) => auroraDeleteAccessKey(...args),
};

const fthMock = {
  id: 'fth',
  region: 'us-east-1',
  isTenantReady: (...args: unknown[]) => fthIsTenantReady(...args),
  deleteAccessKey: (...args: unknown[]) => fthDeleteAccessKey(...args),
};

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (region: string) => {
    mockGetOrchestratorForRegion(region);
    return region === 'us-east-1' ? fthMock : auroraMock;
  },
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './delete-access-key.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };
const KEY_ID = 'key-1';

function eventWithKey(keyId: string | undefined): AuthenticatedEvent {
  const event = buildEvent({ userInfo: USER_INFO, method: 'DELETE' });
  // pathParameters isn't directly supported by buildEvent — attach it here.
  return Object.assign(event, {
    pathParameters: keyId ? { keyId } : undefined,
  }) as unknown as AuthenticatedEvent;
}

function accessKeyItem(region?: string) {
  const item: Record<string, { S: string }> = {
    pk: { S: 'ORG#org-1' },
    sk: { S: `ACCESSKEY#${KEY_ID}` },
    keyName: { S: 'My Key' },
    accessKeyId: { S: 'AKIA1111' },
    createdAt: { S: '2026-01-01T00:00:00Z' },
    status: { S: 'active' },
  };
  if (region) item.region = { S: region };
  return item;
}

describe('delete-access-key baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 400 when keyId is missing', async () => {
    const result = (await baseHandler(eventWithKey(undefined))) as {
      statusCode: number;
    };

    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when the access key row is missing', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    const result = (await baseHandler(eventWithKey(KEY_ID))) as { statusCode: number };

    expect(result.statusCode).toBe(404);
    expect(auroraDeleteAccessKey).not.toHaveBeenCalled();
    expect(fthDeleteAccessKey).not.toHaveBeenCalled();
  });

  it('routes Aurora rows (region=eu-west-1) to the Aurora orchestrator', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1') });
    ddbMock.on(DeleteItemCommand).resolves({});
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockResolvedValue(undefined);

    const result = (await baseHandler(eventWithKey(KEY_ID))) as { statusCode: number };

    expect(result.statusCode).toBe(204);
    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith('eu-west-1');
    expect(auroraDeleteAccessKey).toHaveBeenCalledWith('aurora-t-1', KEY_ID);
    expect(fthDeleteAccessKey).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(1);
  });

  it('routes FTH rows (region=us-east-1) to the FTH orchestrator', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('us-east-1') });
    ddbMock.on(DeleteItemCommand).resolves({});
    fthIsTenantReady.mockReturnValue('fth-t-1');
    fthDeleteAccessKey.mockResolvedValue(undefined);

    const result = (await baseHandler(eventWithKey(KEY_ID))) as { statusCode: number };

    expect(result.statusCode).toBe(204);
    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith('us-east-1');
    expect(fthDeleteAccessKey).toHaveBeenCalledWith('fth-t-1', KEY_ID);
    expect(auroraDeleteAccessKey).not.toHaveBeenCalled();
  });

  it('falls back to Aurora for legacy rows without a region attribute', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem() });
    ddbMock.on(DeleteItemCommand).resolves({});
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockResolvedValue(undefined);

    const result = (await baseHandler(eventWithKey(KEY_ID))) as { statusCode: number };

    expect(result.statusCode).toBe(204);
    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith('eu-west-1');
    expect(auroraDeleteAccessKey).toHaveBeenCalledWith('aurora-t-1', KEY_ID);
  });

  it('returns 503 and does not delete the row when tenant is not ready', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1') });
    auroraIsTenantReady.mockReturnValue(null);

    const result = (await baseHandler(eventWithKey(KEY_ID))) as { statusCode: number };

    expect(result.statusCode).toBe(503);
    expect(auroraDeleteAccessKey).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });

  it('does not delete the DDB row when the orchestrator throws', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1') });
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockRejectedValue(new Error('Aurora API error'));

    await expect(baseHandler(eventWithKey(KEY_ID))).rejects.toThrow('Aurora API error');
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });
});
