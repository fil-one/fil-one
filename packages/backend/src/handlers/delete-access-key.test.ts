import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { auditItemIn, expectNoSecrets } from '../test/audit-assertions.js';

vi.mock('sst', () => sstResourceMock());

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

import { ApiErrorCode, OrgRole } from '@filone/shared';
import { baseHandler } from './delete-access-key.js';
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };
const KEY_ID = 'key-1';

function eventWithKey(keyId: string | undefined, role?: OrgRole): AuthenticatedEvent {
  const event = buildEvent({
    userInfo: {
      ...USER_INFO,
      ...(role ? { membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, role) } : {}),
    },
    method: 'DELETE',
  });
  // pathParameters isn't directly supported by buildEvent — attach it here.
  return Object.assign(event, {
    pathParameters: keyId ? { keyId } : undefined,
  }) as unknown as AuthenticatedEvent;
}

function accessKeyItem(region?: string, createdBy?: string, recovered?: boolean) {
  const item: Record<string, { S: string } | { BOOL: boolean }> = {
    pk: { S: 'ORG#org-1' },
    sk: { S: `ACCESSKEY#${KEY_ID}` },
    keyName: { S: 'My Key' },
    accessKeyId: { S: 'AKIA1111' },
    createdAt: { S: '2026-01-01T00:00:00Z' },
    status: { S: 'active' },
  };
  if (region) item.region = { S: region };
  if (createdBy) item.createdBy = { S: createdBy };
  if (recovered) item.recovered = { BOOL: true };
  return item;
}

/** Every event written on its own, in order: the intent and any completion. */
function standaloneEvents() {
  return ddbMock
    .commandCalls(PutItemCommand)
    .map((call) => unmarshall(call.args[0].input.Item ?? {}));
}

/** The revocation intents, written before the provider call. */
function intentEvents() {
  return standaloneEvents().filter((event) => event.phase === 'intent');
}

/** The completion, which travels with the row deletion. */
function completionEvent() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  return unmarshall(auditItemIn(calls[0].args[0].input.TransactItems));
}

describe('delete-access-key baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(PutItemCommand).resolves({});
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
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockResolvedValue(undefined);

    const result = (await baseHandler(eventWithKey(KEY_ID))) as { statusCode: number };

    expect(result.statusCode).toBe(204);
    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith('eu-west-1');
    expect(auroraDeleteAccessKey).toHaveBeenCalledWith('aurora-t-1', KEY_ID);
    expect(fthDeleteAccessKey).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });

  it('routes FTH rows (region=us-east-1) to the FTH orchestrator', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('us-east-1') });
    ddbMock.on(TransactWriteItemsCommand).resolves({});
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
    ddbMock.on(TransactWriteItemsCommand).resolves({});
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
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('does not delete the DDB row when the orchestrator throws', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1') });
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockRejectedValue(new Error('Aurora API error'));

    await expect(baseHandler(eventWithKey(KEY_ID))).rejects.toThrow('Aurora API error');
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('records an intent before the provider call and a completion with the row deletion', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1') });
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockResolvedValue(undefined);

    await baseHandler(eventWithKey(KEY_ID));

    const [intent] = intentEvents();
    const completion = completionEvent();

    expect(intent).toMatchObject({
      pk: 'ORG#org-1',
      type: 'key.deleted',
      phase: 'intent',
      // The console lists the AKIA… access key id, which the log may not hold
      // in full, so both the subject and the details record its trailing four.
      // The path parameter is the orchestrator's own id for the row and names
      // nothing on screen.
      subject: 'key:1111',
      actor: { kind: 'user', id: 'user-1' },
      // The key is known up front here, so both halves are filed under it.
      details: { keyKind: 's3', keyName: 'My Key', region: 'eu-west-1', keyIdSuffix: '1111' },
    });
    expect(completion).toMatchObject({
      type: 'key.deleted',
      phase: 'completion',
      outcome: 'succeeded',
      subject: 'key:1111',
    });
    // The pair is what makes a crash between them legible.
    expect(completion.correlationId).toBe(intent.correlationId);
    expect(completion.eventId).not.toBe(intent.eventId);
    // The two halves of the same event name the key the same way.
    expect(intent.subject).toBe(`key:${completion.details.keyIdSuffix}`);
    expectNoSecrets(
      auditItemIn(ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems),
    );
  });

  it('names a row written before the access key id was stored by its key id', async () => {
    // Nothing to show an operator, but a subject the viewer can still group by
    // beats none at all.
    const legacyRow = accessKeyItem('eu-west-1');
    delete legacyRow.accessKeyId;
    ddbMock.on(GetItemCommand).resolves({ Item: legacyRow });
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockResolvedValue(undefined);

    await baseHandler(eventWithKey(KEY_ID));

    const [intent] = intentEvents();
    expect(intent.subject).toBe('key:ey-1');
    expect(intent.details).not.toHaveProperty('keyIdSuffix');
  });

  it('revokes the key anyway when the intent cannot be written', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1') });
    ddbMock.on(PutItemCommand).rejects(new Error('AuditTable unavailable'));
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockResolvedValue(undefined);

    // An audit-table outage must never be the reason a leaked key stays live.
    const result = (await baseHandler(eventWithKey(KEY_ID))) as { statusCode: number };

    expect(result.statusCode).toBe(204);
    expect(auroraDeleteAccessKey).toHaveBeenCalledWith('aurora-t-1', KEY_ID);
  });

  it('deletes the row when the event item is the half the table refused', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1') });
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejectsOnce(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
        }),
      )
      .resolves({});
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockResolvedValue(undefined);

    const result = (await baseHandler(eventWithKey(KEY_ID))) as { statusCode: number };

    expect(result.statusCode).toBe(204);
    const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(calls).toHaveLength(2);
    // The retry carries the delete and nothing else.
    expect(calls[1].args[0].input.TransactItems).toHaveLength(1);
    expect(calls[1].args[0].input.TransactItems![0].Delete).toBeDefined();
  });

  it('closes the correlation as failed when the provider refuses the revocation', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1') });
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockRejectedValue(new Error('Aurora API error'));

    await expect(baseHandler(eventWithKey(KEY_ID))).rejects.toThrow('Aurora API error');

    const [intent, completion] = standaloneEvents();
    expect(completion).toMatchObject({ phase: 'completion', outcome: 'failed' });
    expect(completion.correlationId).toBe(intent.correlationId);
  });

  it('leaves a dangling intent when the provider revokes and the local write never lands', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1') });
    ddbMock.on(TransactWriteItemsCommand).rejects(new Error('DynamoDB unavailable'));
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockResolvedValue(undefined);

    await expect(baseHandler(eventWithKey(KEY_ID))).rejects.toThrow('DynamoDB unavailable');

    // The intent is the record of what happened at the vendor. Without it,
    // a revoked credential whose row survived would leave no trace at all.
    expect(intentEvents()).toHaveLength(1);
    expect(intentEvents()[0].phase).toBe('intent');
  });

  it('writes no intent when the request never reaches the provider', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1', 'user-2') });

    const result = (await baseHandler(eventWithKey(KEY_ID, OrgRole.Member))) as {
      statusCode: number;
    };

    expect(result.statusCode).toBe(403);
    expect(intentEvents()).toHaveLength(0);
  });
});

describe('whose key a caller may revoke', () => {
  // `keys.manage_own` gets the caller through the chain; which key they are
  // holding is a question only the handler can answer, because it has to read
  // the row first.
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    auroraIsTenantReady.mockReturnValue('aurora-t-1');
    auroraDeleteAccessKey.mockResolvedValue(undefined);
  });

  it('lets a Member revoke a key they created', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1', USER_INFO.userId) });

    const result = (await baseHandler(eventWithKey(KEY_ID, OrgRole.Member))) as {
      statusCode: number;
    };

    expect(result.statusCode).toBe(204);
  });

  it("refuses a Member someone else's key, before the provider is touched", async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1', 'user-2') });

    const result = (await baseHandler(eventWithKey(KEY_ID, OrgRole.Member))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    // The provider-side deletion is the irreversible half.
    expect(auroraDeleteAccessKey).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('refuses a Member an unattributed key, which nobody can claim', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1') });

    const result = (await baseHandler(eventWithKey(KEY_ID, OrgRole.Member))) as {
      statusCode: number;
    };

    expect(result.statusCode).toBe(403);
    expect(auroraDeleteAccessKey).not.toHaveBeenCalled();
  });

  it('refuses a Member a recovered key that names them, because the name is a guess', async () => {
    // `recoverDuplicateKey` writes the retrying caller into createdBy after a
    // partial failure. The collision that reaches that path is two people
    // picking the same key name, so the row may well name the wrong one.
    ddbMock
      .on(GetItemCommand)
      .resolves({ Item: accessKeyItem('eu-west-1', USER_INFO.userId, true) });

    const result = (await baseHandler(eventWithKey(KEY_ID, OrgRole.Member))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(auroraDeleteAccessKey).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('lets keys.manage_all revoke a recovered key', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves({ Item: accessKeyItem('eu-west-1', USER_INFO.userId, true) });

    const result = (await baseHandler(eventWithKey(KEY_ID, OrgRole.Admin))) as {
      statusCode: number;
    };

    expect(result.statusCode).toBe(204);
  });

  it.each([OrgRole.Owner, OrgRole.Admin])('lets %s revoke any key in the org', async (role) => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1', 'user-2') });

    const result = (await baseHandler(eventWithKey(KEY_ID, role))) as { statusCode: number };

    expect(result.statusCode).toBe(204);
  });

  it('lets keys.manage_all revoke an unattributed key', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: accessKeyItem('eu-west-1') });

    const result = (await baseHandler(eventWithKey(KEY_ID, OrgRole.Admin))) as {
      statusCode: number;
    };

    expect(result.statusCode).toBe(204);
  });
});
