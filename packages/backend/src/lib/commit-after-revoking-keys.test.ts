import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  PutItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { OrgRole, S3Region } from '@filone/shared';
import type { AccessKeySummary } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.ts';
import { auditItemIn } from '../test/audit-assertions.ts';

vi.mock('sst', () => sstResourceMock());

const mockRevokeMemberKeys = vi.fn();
vi.mock('./revoke-member-keys.ts', () => ({
  revokeMemberKeys: (...args: unknown[]) => mockRevokeMemberKeys(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

import { accessKeyMintSeqUnchangedCheck } from './access-key-mint-seq.ts';
import { AuditSubjects, userActor } from './audit.ts';
import { commitAfterRevokingKeys } from './commit-after-revoking-keys.ts';
import type { AccessKeyToRevoke } from './member-keys.ts';

const ORG_ID = 'org-1';
const MEMBER_ID = 'member-1';
const ITEMS: TransactWriteItem[] = [
  { Put: { TableName: 'UserInfoTable', Item: { pk: { S: `USER#${MEMBER_ID}` } } } },
];

function keyToRevoke(id: string): AccessKeyToRevoke {
  return {
    id,
    keyName: `key ${id}`,
    accessKeyId: `AKIAEXAMPLE${id}`,
    region: S3Region.UsEast1,
    createdAt: '2026-02-01T00:00:00.000Z',
    createdBy: MEMBER_ID,
    reason: 'exceeds_role',
    excess: [],
  };
}

function summary(id: string): AccessKeySummary {
  return {
    id,
    keyName: `key ${id}`,
    accessKeyIdSuffix: id,
    region: S3Region.UsEast1,
    createdAt: '2026-02-01T00:00:00.000Z',
    reason: 'exceeds_role',
    excess: [],
  };
}

const KEYS = [keyToRevoke('0001'), keyToRevoke('0002')];
const REVOKED = KEYS.map((key) => summary(key.id));

const onCancelled = vi.fn();
const onRefused = vi.fn();
const notifyMember = vi.fn();

function commit(overrides: Record<string, unknown> = {}) {
  return commitAfterRevokingKeys({
    items: ITEMS,
    keys: KEYS,
    fence: { userId: MEMBER_ID, mintSeq: undefined },
    orgId: ORG_ID,
    orgProfile: undefined,
    actor: userActor({ userId: 'admin-1' }),
    trigger: 'role_narrowing',
    auditEventType: 'member.role_changed',
    subject: AuditSubjects.user(MEMBER_ID),
    details: { role: OrgRole.Member, previousRole: OrgRole.Admin },
    source: 'the-change',
    onCancelled,
    onRefused,
    notifyMember,
    ...overrides,
  });
}

/** Every event written on its own: intents, and completions with no items to ride. */
function standaloneEvents() {
  return ddbMock
    .commandCalls(PutItemCommand)
    .map((call) => unmarshall(call.args[0].input.Item ?? {}));
}

/** The transactions that carried the membership items, each with its event. */
function committedWrites() {
  return ddbMock.commandCalls(TransactWriteItemsCommand).map((call) => {
    const items = call.args[0].input.TransactItems ?? [];
    return { items: items.slice(0, -1), event: unmarshall(auditItemIn(items)) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ddbMock.reset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  ddbMock.on(PutItemCommand).resolves({});
  ddbMock.on(TransactWriteItemsCommand).resolves({});
  mockRevokeMemberKeys.mockResolvedValue({ revoked: REVOKED, refused: [] });
  onCancelled.mockResolvedValue({ statusCode: 409 });
  onRefused.mockReturnValue({ statusCode: 502 });
  notifyMember.mockResolvedValue(undefined);
});

/**
 * The cancellation DynamoDB sends when a condition fails. Takes several
 * positions because DynamoDB reports every failed condition, not just the first.
 */
function cancelledAt(failed: number | readonly number[], itemCount: number) {
  const positions = new Set(typeof failed === 'number' ? [failed] : failed);
  return new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: Array.from({ length: itemCount }, (_unused, position) => ({
      Code: positions.has(position) ? 'ConditionalCheckFailed' : 'None',
    })),
  });
}

/** The item `commitAfterRevokingKeys` appends for `fence`, at the end of the caller's. */
const FENCE_CHECK = accessKeyMintSeqUnchangedCheck(ORG_ID, {
  userId: MEMBER_ID,
  mintSeq: undefined,
});

describe('commitAfterRevokingKeys', () => {
  it('stays one transaction and one event when there is no key to revoke', async () => {
    const outcome = await commit({ keys: [] });

    expect(outcome).toStrictEqual({ revoked: [] });
    expect(mockRevokeMemberKeys).not.toHaveBeenCalled();
    expect(standaloneEvents()).toStrictEqual([]);
    const [write] = committedWrites();
    expect(committedWrites()).toHaveLength(1);
    // The caller's items plus the fence, which a change that revokes nothing
    // still carries — an empty listing is exactly the case a mint slips past.
    expect(write!.items).toStrictEqual([...ITEMS, FENCE_CHECK]);
    expect(write!.event).toMatchObject({
      type: 'member.role_changed',
      details: { role: OrgRole.Member, previousRole: OrgRole.Admin },
    });
    expect(write!.event).not.toHaveProperty('phase');
  });

  it('answers the fence itself, so the caller cannot mistake it for its own item', async () => {
    // A key was minted after the listing. The keys already revoked went before
    // it did, so they ride the arm the caller has to answer.
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(ITEMS.length, ITEMS.length + 2));

    expect(await commit()).toStrictEqual({ keyMinted: REVOKED });
    expect(onCancelled).not.toHaveBeenCalled();
    // Their clients are already broken either way.
    expect(notifyMember).toHaveBeenCalledWith(REVOKED);
  });

  it('leaves the caller its own answer when the fence is not the only item that failed', async () => {
    // The org-deletion fence is the caller's item 0, and it has no retry. A key
    // minted in the same window must not turn that into "try again".
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt([0, ITEMS.length], ITEMS.length + 2));
    const cancelled = new Error('org deleting');
    onCancelled.mockRejectedValue(cancelled);

    await expect(commit()).rejects.toThrow('org deleting');
  });

  it('reads no fence into a change that carries none', async () => {
    // A promotion strands no key and appends no fence, so the position the fence
    // would have held belongs to the audit item. Nothing there is a mint.
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt([0, ITEMS.length], ITEMS.length + 1));

    const outcome = await commit({ keys: [], fence: undefined });

    expect(outcome).toStrictEqual({ response: { statusCode: 409 } });
    expect(committedWrites()[0]!.items).toStrictEqual(ITEMS);
  });

  it('hands a cancellation with no revocation to the caller with nothing revoked', async () => {
    const cancelled = new Error('cancelled');
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelled);

    const outcome = await commit({ keys: [] });

    expect(outcome).toStrictEqual({ response: { statusCode: 409 } });
    expect(onCancelled).toHaveBeenCalledWith(cancelled, []);
    expect(notifyMember).not.toHaveBeenCalled();
  });

  it('revokes before it writes, and the completion carries the intent plus the ids', async () => {
    const outcome = await commit();

    expect(outcome).toStrictEqual({ revoked: REVOKED });
    expect(mockRevokeMemberKeys).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, keys: KEYS, reason: 'role_narrowing' }),
    );

    const [intent] = standaloneEvents();
    expect(intent).toMatchObject({
      type: 'member.role_changed',
      phase: 'intent',
      details: { role: OrgRole.Member, previousRole: OrgRole.Admin },
    });

    const [write] = committedWrites();
    expect(committedWrites()).toHaveLength(1);
    expect(write!.items).toStrictEqual([...ITEMS, FENCE_CHECK]);
    expect(write!.event).toMatchObject({
      type: 'member.role_changed',
      phase: 'completion',
      outcome: 'succeeded',
      correlationId: intent!.correlationId,
    });
    expect(write!.event.details).toStrictEqual({
      ...(intent!.details as Record<string, unknown>),
      revokedKeys: ['0001', '0002'],
    });
    expect(notifyMember).not.toHaveBeenCalled();
  });

  it('writes nothing when a vendor refuses, tells the member, and answers with the refusal', async () => {
    const [went] = REVOKED;
    mockRevokeMemberKeys.mockResolvedValue({ revoked: [went], refused: [summary('0002')] });

    const outcome = await commit();

    expect(outcome).toStrictEqual({ response: { statusCode: 502 } });
    expect(committedWrites()).toStrictEqual([]);
    const completion = standaloneEvents().find((event) => event.phase === 'completion');
    expect(completion).toMatchObject({ outcome: 'failed', details: { revokedKeys: ['0001'] } });
    expect(notifyMember).toHaveBeenCalledWith([went]);
    expect(onRefused).toHaveBeenCalledWith([summary('0002')], [went]);
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it('tells nobody when the caller has no member to tell', async () => {
    // The flow whose key holder is the caller answers them in the response.
    mockRevokeMemberKeys.mockResolvedValue({ revoked: [], refused: [summary('0001')] });

    const outcome = await commit({ notifyMember: undefined });

    expect(outcome).toStrictEqual({ response: { statusCode: 502 } });
    expect(notifyMember).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledWith([summary('0001')], []);
  });

  it('names what went when the write cancels after the revocation, and closes the intent', async () => {
    const cancelled = new Error('cancelled');
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelled);

    const outcome = await commit();

    expect(outcome).toStrictEqual({ response: { statusCode: 409 } });
    expect(console.error).toHaveBeenCalledWith(
      '[the-change] The write cancelled after revoking keys',
      { orgId: ORG_ID, revoked: 2 },
    );
    expect(notifyMember).toHaveBeenCalledWith(REVOKED);
    expect(onCancelled).toHaveBeenCalledWith(cancelled, REVOKED);
    // The succeeded completion rode the transaction that cancelled, so it went
    // with it. Without this the intent dangles and an operator cannot tell a
    // refused request from a process that died holding one.
    expect(standaloneEvents().map((event) => [event.phase, event.outcome])).toStrictEqual([
      ['intent', undefined],
      ['completion', 'failed'],
    ]);
  });

  it('answers the cancellation even when the completion that closes it cannot be written', async () => {
    // An audit outage must not become the answer: the keys are gone and the
    // caller needs the refusal that says so, not a 500 about bookkeeping.
    ddbMock.on(TransactWriteItemsCommand).rejects(new Error('cancelled'));
    ddbMock.on(PutItemCommand).resolvesOnce({}).rejects(new Error('audit unavailable'));

    expect(await commit()).toStrictEqual({ response: { statusCode: 409 } });
    expect(console.error).toHaveBeenCalledWith(
      "[the-change] The cancelled write's own completion did not land",
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });

  it('lets the caller throw out of a cancellation rather than answering for it', async () => {
    // The org-deletion fence has no remedy: its error is the 410, not a response.
    ddbMock.on(TransactWriteItemsCommand).rejects(new Error('cancelled'));
    onCancelled.mockRejectedValue(new Error('org deleting'));

    await expect(commit()).rejects.toThrow('org deleting');
    expect(notifyMember).toHaveBeenCalledWith(REVOKED);
  });
});
