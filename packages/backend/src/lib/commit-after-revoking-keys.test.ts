import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  PutItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { OrgRole, S3Region } from '@filone/shared';
import type { AccessKeySummary } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { auditItemIn } from '../test/audit-assertions.js';

vi.mock('sst', () => sstResourceMock());

const mockRevokeMemberKeys = vi.fn();
vi.mock('./revoke-member-keys.js', () => ({
  revokeMemberKeys: (...args: unknown[]) => mockRevokeMemberKeys(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

import { AuditSubjects, userActor } from './audit.js';
import { commitAfterRevokingKeys } from './commit-after-revoking-keys.js';
import type { AccessKeyToRevoke } from './member-keys.js';

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
    orgId: ORG_ID,
    orgProfile: undefined,
    actor: userActor({ userId: 'admin-1' }),
    trigger: 'role_narrowing',
    type: 'member.role_changed',
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

describe('commitAfterRevokingKeys', () => {
  it('stays one transaction and one event when there is no key to revoke', async () => {
    const outcome = await commit({ keys: [] });

    expect(outcome).toStrictEqual({ revoked: [] });
    expect(mockRevokeMemberKeys).not.toHaveBeenCalled();
    expect(standaloneEvents()).toStrictEqual([]);
    const [write] = committedWrites();
    expect(committedWrites()).toHaveLength(1);
    expect(write!.items).toStrictEqual(ITEMS);
    expect(write!.event).toMatchObject({
      type: 'member.role_changed',
      details: { role: OrgRole.Member, previousRole: OrgRole.Admin },
    });
    expect(write!.event).not.toHaveProperty('phase');
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
    expect(write!.items).toStrictEqual(ITEMS);
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

  it('names what went when the write cancels after the revocation', async () => {
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
  });

  it('lets the caller throw out of a cancellation rather than answering for it', async () => {
    // The org-deletion fence has no remedy: its error is the 410, not a response.
    ddbMock.on(TransactWriteItemsCommand).rejects(new Error('cancelled'));
    onCancelled.mockRejectedValue(new Error('org deleting'));

    await expect(commit()).rejects.toThrow('org deleting');
    expect(notifyMember).toHaveBeenCalledWith(REVOKED);
  });
});
