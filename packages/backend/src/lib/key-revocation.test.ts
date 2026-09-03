import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  PutItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { S3Region } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { auditItemIn, expectNoSecrets } from '../test/audit-assertions.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import { userActor } from './audit.js';
import { revokeAccessKey } from './key-revocation.js';
import type { RevokeAccessKeyArgs } from './key-revocation.js';

const ORG_ID = 'org-1';
const KEY_ID = 'key-1';
const deleteAccessKey = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  ddbMock.reset();
  ddbMock.on(PutItemCommand).resolves({});
  ddbMock.on(TransactWriteItemsCommand).resolves({});
});

function revoke(overrides: Partial<RevokeAccessKeyArgs> = {}) {
  return revokeAccessKey({
    orgId: ORG_ID,
    keyId: KEY_ID,
    accessKeyId: 'AKIA1111',
    keyName: 'My Key',
    region: S3Region.UsEast1,
    orchestrator: { deleteAccessKey },
    tenantId: 'fth:org-1',
    actor: userActor({ userId: 'admin-1', email: 'admin@example.test' }),
    ...overrides,
    // Last, and never undefined: `reason` is required, and a bare `revoke()`
    // stands for the member revoking their own key.
    reason: overrides.reason ?? 'user_requested',
  });
}

/** Every event written on its own: the intent, and a completion with nothing to carry. */
function standaloneEvents() {
  return ddbMock
    .commandCalls(PutItemCommand)
    .map((call) => unmarshall(call.args[0].input.Item ?? {}));
}

/** The completion, which travels with the row deletion. */
function completionEvent() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  return unmarshall(auditItemIn(calls[0]!.args[0].input.TransactItems));
}

describe('revokeAccessKey', () => {
  it('revokes at the orchestrator and deletes the row in the completion', async () => {
    await revoke();

    expect(deleteAccessKey).toHaveBeenCalledWith('fth:org-1', KEY_ID);
    expect(
      ddbMock.commandCalls(TransactWriteItemsCommand)[0]!.args[0].input.TransactItems?.[0],
    ).toStrictEqual({
      Delete: {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: `ACCESSKEY#${KEY_ID}` } },
      },
    });
  });

  it('records the reason the pass revoked it', async () => {
    await revoke({ reason: 'role_narrowing' });

    const [intent] = standaloneEvents();
    const completion = completionEvent();

    expect(intent).toMatchObject({
      type: 'key.deleted',
      phase: 'intent',
      subject: 'key:1111',
      details: { keyKind: 's3', keyName: 'My Key', region: 'us-east-1', reason: 'role_narrowing' },
    });
    expect(completion).toMatchObject({ phase: 'completion', outcome: 'succeeded' });
    expect(completion.correlationId).toBe(intent!.correlationId);
    expectNoSecrets(
      auditItemIn(ddbMock.commandCalls(TransactWriteItemsCommand)[0]!.args[0].input.TransactItems),
    );
  });

  it('names the request itself when the holder revoked their own key', async () => {
    await revoke();

    expect(standaloneEvents()[0]!.details).toMatchObject({ reason: 'user_requested' });
  });

  it('names the actor who asked, who need not be the holder', async () => {
    await revoke({ reason: 'member_removed' });

    expect(standaloneEvents()[0]!.actor).toStrictEqual({
      kind: 'user',
      id: 'admin-1',
      email: 'admin@example.test',
    });
  });

  it('closes the correlation as failed and rethrows when the orchestrator refuses', async () => {
    deleteAccessKey.mockRejectedValueOnce(new Error('vendor down'));

    await expect(revoke({ reason: 'role_narrowing' })).rejects.toThrow('vendor down');

    const events = standaloneEvents();
    expect(events.map((event) => [event.phase, event.outcome])).toStrictEqual([
      ['intent', undefined],
      ['completion', 'failed'],
    ]);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('falls back to the orchestrator id when the row never stored an access key id', async () => {
    await revoke({ accessKeyId: undefined });

    // Four characters of the orchestrator's own id match nothing an operator
    // can see, so no `keyIdSuffix` is recorded either.
    const [intent] = standaloneEvents();
    expect(intent!.subject).toBe('key:ey-1');
    expect(intent!.details).not.toHaveProperty('keyIdSuffix');
  });

  it('revokes anyway when the intent cannot be written', async () => {
    // An AuditTable outage must never be the reason a leaked key stays live.
    ddbMock.on(PutItemCommand).rejects(new Error('AuditTable unavailable'));

    await revoke({ reason: 'role_narrowing' });

    expect(deleteAccessKey).toHaveBeenCalledWith('fth:org-1', KEY_ID);
  });
});
