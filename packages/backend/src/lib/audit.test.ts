import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  PutItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { AUDIT_EVENT_TYPES, AUDIT_RETENTION_DAYS, OrgRole } from '@filone/shared';
import type {
  AuditEventDetails,
  AuditEventPhase,
  AuditEventRecord,
  AuditEventType,
} from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import {
  AUDIT_DETAIL_MAX_STRING_LENGTH,
  AuditKeys,
  AuditSubjects,
  ProhibitedAuditContentError,
  appendAuditEvent,
  auditEvent,
  auditPut,
  commitAudited,
  newCorrelationId,
} from './audit.js';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = '2026-08-15T12:00:00.000Z';
const ACTOR = { kind: 'user', id: USER_ID, email: 'owner@example.com' } as const;

/** One payload per event type, so the registry is exercised whole. */
const DETAILS: { [T in AuditEventType]: AuditEventDetails[T] } = {
  'org.created': { orgName: 'Acme', source: 'signup' },
  'org.renamed': { name: 'Acme Two', previousName: 'Acme' },
  'member.invited': { inviteId: 'inv-1', email: 'invitee@example.com', role: OrgRole.Member },
  'invite.revoked': { inviteId: 'inv-1', email: 'invitee@example.com' },
  'invite.accepted': { inviteId: 'inv-1', email: 'invitee@example.com', role: OrgRole.Member },
  'member.role_changed': { role: OrgRole.Admin, previousRole: OrgRole.Member },
  'member.removed': { role: OrgRole.Member },
  'ownership.transferred': { fromUserId: USER_ID, toUserId: 'user-2' },
  'key.created': { keyKind: 's3', keyName: 'ci', region: 'eu-west-1', keyIdSuffix: 'AMPL' },
  'key.revoked': { keyKind: 's3', keyName: 'ci', region: 'eu-west-1' },
};

function renamed(
  overrides: { phase?: AuditEventPhase; correlationId?: string } = {},
): AuditEventRecord<'org.renamed'> {
  return auditEvent({
    type: 'org.renamed',
    actor: ACTOR,
    orgId: ORG_ID,
    subject: AuditSubjects.org(ORG_ID),
    details: { name: 'Acme Two', previousName: 'Acme' },
    ...overrides,
  });
}

describe('AuditKeys', () => {
  it('addresses an org partition and orders events by the clock', () => {
    expect(AuditKeys.orgPk(ORG_ID)).toBe(`ORG#${ORG_ID}`);
    expect(AuditKeys.eventSk(NOW, 'evt-1')).toBe(`${NOW}#evt-1`);
  });

  it('sorts events written in the same millisecond as two rows, in id order', () => {
    const [first, second] = [AuditKeys.eventSk(NOW, 'a'), AuditKeys.eventSk(NOW, 'b')];
    expect(first).not.toBe(second);
    expect([second, first].sort()).toStrictEqual([first, second]);
  });

  it('orders an older event before a newer one', () => {
    const older = AuditKeys.eventSk('2026-08-15T11:59:59.999Z', 'zzz');
    expect([AuditKeys.eventSk(NOW, 'aaa'), older].sort()[0]).toBe(older);
  });
});

describe('AuditSubjects', () => {
  it('spells each target one way', () => {
    expect(AuditSubjects.org(ORG_ID)).toBe(`org:${ORG_ID}`);
    expect(AuditSubjects.user(USER_ID)).toBe(`user:${USER_ID}`);
    expect(AuditSubjects.invite('inv-1')).toBe('invite:inv-1');
    expect(AuditSubjects.key('key-1')).toBe('key:key-1');
  });
});

describe('auditEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps the envelope', () => {
    const event = renamed();

    expect(event).toStrictEqual({
      eventId: expect.any(String),
      type: 'org.renamed',
      actor: ACTOR,
      orgId: ORG_ID,
      subject: `org:${ORG_ID}`,
      details: { name: 'Acme Two', previousName: 'Acme' },
      createdAt: NOW,
      ttl: expect.any(Number),
    });
  });

  it('stamps a TTL 90 days out, in epoch seconds', () => {
    const event = renamed();

    const expected = Date.parse(NOW) / 1000 + AUDIT_RETENTION_DAYS * 24 * 60 * 60;
    expect(event.ttl).toBe(expected);
    // Stated the other way round, because the number itself is unreadable: the
    // event expires a quarter after it was written.
    expect(new Date(event.ttl * 1000).toISOString()).toBe('2026-11-13T12:00:00.000Z');
  });

  it('gives every event its own id', () => {
    expect(renamed().eventId).not.toBe(renamed().eventId);
  });

  it('leaves phase and correlationId off a single-phase event', () => {
    const event = renamed();

    expect(event).not.toHaveProperty('phase');
    expect(event).not.toHaveProperty('correlationId');
  });

  it('carries the intent/completion pair on the same correlation id', () => {
    const correlationId = newCorrelationId();
    const intent = renamed({ phase: 'intent', correlationId });
    const completion = renamed({ phase: 'completion', correlationId });

    expect(intent.phase).toBe('intent');
    expect(completion.phase).toBe('completion');
    expect(intent.correlationId).toBe(completion.correlationId);
    expect(intent.eventId).not.toBe(completion.eventId);
  });

  it('gives two flows different correlation ids', () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });

  it.each(AUDIT_EVENT_TYPES)('constructs a %s event', (type) => {
    const event = auditEvent({
      type,
      actor: ACTOR,
      orgId: ORG_ID,
      subject: AuditSubjects.org(ORG_ID),
      details: DETAILS[type],
    });

    expect(event.type).toBe(type);
    expect(event.details).toStrictEqual(DETAILS[type]);
  });
});

describe('the prohibited-content guard', () => {
  function build(details: unknown) {
    return () =>
      auditEvent({
        type: 'org.renamed',
        actor: ACTOR,
        orgId: ORG_ID,
        subject: AuditSubjects.org(ORG_ID),
        details: details as AuditEventDetails['org.renamed'],
      });
  }

  it.each([
    ['secretAccessKey', { name: 'Acme', secretAccessKey: 'AKIA...' }],
    ['tokenHash', { name: 'Acme', tokenHash: 'deadbeef' }],
    ['password', { name: 'Acme', password: 'hunter2' }],
    ['presignedUrl', { name: 'Acme', presignedUrl: 'https://example.com/?X-Amz-Signature=1' }],
    ['authorization', { name: 'Acme', authorization: 'Bearer abc' }],
  ])('refuses a payload with a %s field', (_label, details) => {
    expect(build(details)).toThrow(ProhibitedAuditContentError);
  });

  it('finds a prohibited field nested inside the payload', () => {
    expect(build({ name: 'Acme', changed: { by: { refreshToken: 'rt' } } })).toThrow(
      /details\.changed\.by\.refreshToken/,
    );
  });

  it('finds a prohibited field inside an array entry', () => {
    expect(build({ name: 'Acme', members: [{ id: 'a' }, { sessionCookie: 'c' }] })).toThrow(
      /details\.members\[1\]\.sessionCookie/,
    );
  });

  it('refuses a value carrying a RAG key token however the field is named', () => {
    expect(build({ name: 'Acme', note: 'issued sk_rag_AbC12345' })).toThrow(
      /carries an API key token/,
    );
  });

  it('refuses a value too long to be the name or identifier it claims to be', () => {
    expect(build({ name: 'x'.repeat(AUDIT_DETAIL_MAX_STRING_LENGTH + 1) })).toThrow(
      new RegExp(`longer than ${AUDIT_DETAIL_MAX_STRING_LENGTH}`),
    );
  });

  it('accepts a value at the limit', () => {
    expect(build({ name: 'x'.repeat(AUDIT_DETAIL_MAX_STRING_LENGTH) })).not.toThrow();
  });

  it('refuses a payload nested deeper than an event has any reason to be', () => {
    expect(build({ name: 'Acme', a: { b: { c: { d: { e: 'deep' } } } } })).toThrow(/nests deeper/);
  });

  it('names the offending path, so the failure says which field to remove', () => {
    let thrown: unknown;
    try {
      build({ name: 'Acme', apiToken: 'x' })();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProhibitedAuditContentError);
    expect((thrown as ProhibitedAuditContentError).path).toBe('details.apiToken');
  });

  it('runs at construction, so a rejected event never reaches the transaction', () => {
    ddbMock.reset();
    ddbMock.on(TransactWriteItemsCommand).resolves({});

    // The mutation the event would have ridden with is built after it, so the
    // throw lands before any write is prepared, let alone sent.
    expect(build({ name: 'Acme', secretAccessKey: 'no' })).toThrow(ProhibitedAuditContentError);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('lets the payloads the M1 event types actually carry through', () => {
    for (const type of AUDIT_EVENT_TYPES) {
      expect(() =>
        auditEvent({
          type,
          actor: ACTOR,
          orgId: ORG_ID,
          subject: AuditSubjects.org(ORG_ID),
          details: DETAILS[type],
        }),
      ).not.toThrow();
    }
  });
});

describe('auditPut', () => {
  it('writes to AuditTable at the derived key, create-only', () => {
    const event = renamed();

    expect(auditPut(event)).toStrictEqual({
      Put: {
        TableName: 'AuditTable',
        Item: expect.objectContaining({
          pk: { S: `ORG#${ORG_ID}` },
          sk: { S: `${event.createdAt}#${event.eventId}` },
          type: { S: 'org.renamed' },
          orgId: { S: ORG_ID },
          subject: { S: `org:${ORG_ID}` },
          ttl: { N: String(event.ttl) },
        }),
        // Append-only: a Put that would land on an existing event cancels the
        // transaction rather than rewriting history.
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    });
  });

  it('marshalls the actor and the payload as maps the viewer can read back', () => {
    const item = auditPut(renamed()).Put!.Item!;

    expect(item.actor).toStrictEqual({
      M: { kind: { S: 'user' }, id: { S: USER_ID }, email: { S: 'owner@example.com' } },
    });
    expect(item.details).toStrictEqual({
      M: { name: { S: 'Acme Two' }, previousName: { S: 'Acme' } },
    });
  });
});

describe('commitAudited', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(TransactWriteItemsCommand).resolves({});
  });

  const mutation = {
    Put: {
      TableName: 'OrgTable',
      Item: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: `MEMBER#${USER_ID}` } },
    },
  };

  it('sends the caller’s items and the event as one transaction', async () => {
    const event = renamed();

    await commitAudited({ items: [mutation], event });

    const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.TransactItems).toStrictEqual([mutation, auditPut(event)]);
  });

  it('composes with a transaction that already spans tables', async () => {
    const billing = {
      Put: { TableName: 'UserInfoTable', Item: { pk: { S: 'x' }, sk: { S: 'y' } } },
    };

    await commitAudited({ items: [mutation, billing], event: renamed() });

    const items = ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems!;
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.Put?.TableName)).toStrictEqual([
      'OrgTable',
      'UserInfoTable',
      'AuditTable',
    ]);
  });

  it('fails the mutation when the event cannot be written', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(new Error('AuditTable unavailable'));

    // The ADR accepts this: an audit-table outage blocks control-plane writes
    // rather than letting a membership change land unrecorded.
    await expect(commitAudited({ items: [mutation], event: renamed() })).rejects.toThrow(
      'AuditTable unavailable',
    );
  });
});

describe('appendAuditEvent', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(PutItemCommand).resolves({});
  });

  it('puts one event, create-only, with no mutation attached', async () => {
    const event = renamed({ phase: 'intent', correlationId: 'corr-1' });

    await appendAuditEvent(event);

    const calls = ddbMock.commandCalls(PutItemCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toStrictEqual({
      TableName: 'AuditTable',
      Item: expect.objectContaining({
        pk: { S: `ORG#${ORG_ID}` },
        sk: { S: `${event.createdAt}#${event.eventId}` },
        phase: { S: 'intent' },
        correlationId: { S: 'corr-1' },
      }),
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });
});
