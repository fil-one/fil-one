import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  PutItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { AUDIT_EVENT_TYPES, AUDIT_RETENTION_DAYS, OrgRole } from '@filone/shared';
import type {
  AuditEventDetails,
  AuditEventRecord,
  AuditEventType,
  TwoPhaseAuditEvent,
} from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import {
  AUDIT_DETAIL_MAX_STRING_LENGTH,
  AuditAppendError,
  AuditCompletionConflictError,
  AuditKeys,
  AuditSubjects,
  ProhibitedAuditContentError,
  TRANSACT_WRITE_ITEM_LIMIT,
  appendAuditEvent,
  auditEvent,
  auditPut,
  commitAudited,
  newCorrelationId,
  twoPhaseAudit,
  userActor,
} from './audit.js';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const KEY_ID = 'key-1';
const NOW = '2026-08-15T12:00:00.000Z';
const ACTOR = { kind: 'user', id: USER_ID, email: 'owner@example.com' } as const;

/** One payload per event type, so the registry is exercised whole. */
const DETAILS: { [T in AuditEventType]: AuditEventDetails[T] } = {
  'org.created': { orgName: 'Acme', source: 'signup' },
  'org.renamed': { name: 'Acme Two', previousName: 'Acme' },
  'org.logo_updated': { logoUrl: 'https://cdn.example.com/logo.png' },
  'member.invited': { inviteId: 'inv-1', email: 'invitee@example.com', role: OrgRole.Member },
  'invite.revoked': { inviteId: 'inv-1', email: 'invitee@example.com' },
  'invite.accepted': { inviteId: 'inv-1', email: 'invitee@example.com', role: OrgRole.Member },
  'member.role_changed': { role: OrgRole.Admin, previousRole: OrgRole.Member },
  'member.removed': { role: OrgRole.Member },
  'ownership.transferred': { fromUserId: USER_ID, toUserId: 'user-2' },
  'key.created': { keyKind: 's3', keyName: 'ci', region: 'eu-west-1', keyIdSuffix: 'AMPL' },
  'key.deleted': { keyKind: 's3', keyName: 'ci', region: 'eu-west-1' },
  'audit.exported': {
    from: '2026-05-17T12:00:00.000Z',
    to: NOW,
    eventType: 'member.removed',
    actorId: USER_ID,
    rowCount: 12,
  },
};

function renamed(): AuditEventRecord<'org.renamed'> {
  return auditEvent({
    type: 'org.renamed',
    actor: ACTOR,
    orgId: ORG_ID,
    subject: AuditSubjects.org(ORG_ID),
    details: { name: 'Acme Two', previousName: 'Acme' },
  });
}

function revokedIntent(correlationId: string): TwoPhaseAuditEvent {
  return auditEvent({
    type: 'key.deleted',
    actor: ACTOR,
    orgId: ORG_ID,
    subject: AuditSubjects.key('s3', KEY_ID),
    details: { keyKind: 's3', keyName: 'ci' },
    phase: 'intent',
    correlationId,
  });
}

/** A cancellation whose reasons name which item failed, as DynamoDB sends it. */
function cancelledOn(codes: (string | undefined)[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code: Code ?? 'None' })),
  });
}

const MUTATION = {
  Put: {
    TableName: 'OrgTable',
    Item: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: `MEMBER#${USER_ID}` } },
  },
};

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
    // Never the whole id: for an S3 key the id IS the AKIA… access key id, and
    // the details of the same event carry only these four characters.
    expect(AuditSubjects.key('s3', 'AKIAIOSFODNN7EXAMPLE')).toBe('key:MPLE');
    expect(AuditSubjects.key('rag', 'sk_rag_AbC12xyz')).toBe('key:sk_rag_AbC12');
  });
});

describe('userActor', () => {
  it('names the member and their verified email', () => {
    expect(userActor({ userId: USER_ID, email: 'owner@example.com' })).toStrictEqual({
      kind: 'user',
      id: USER_ID,
      email: 'owner@example.com',
    });
  });

  it('omits the email rather than storing an unverified one', () => {
    // getVerifiedEmail returns undefined for an unverified claim, and the
    // builder is what keeps that decision in one place.
    expect(userActor({ userId: USER_ID })).toStrictEqual({ kind: 'user', id: USER_ID });
    expect(userActor({ userId: USER_ID })).not.toHaveProperty('email');
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

  it('leaves phase, correlationId, and outcome off a single-phase event', () => {
    const event = renamed();

    expect(event).not.toHaveProperty('phase');
    expect(event).not.toHaveProperty('correlationId');
    expect(event).not.toHaveProperty('outcome');
  });

  it('carries the intent/completion pair on the same correlation id', () => {
    const correlationId = newCorrelationId();
    const intent = revokedIntent(correlationId);
    const completion = auditEvent({
      type: 'key.deleted',
      actor: ACTOR,
      orgId: ORG_ID,
      subject: AuditSubjects.key('s3', KEY_ID),
      details: { keyKind: 's3', keyName: 'ci' },
      phase: 'completion',
      correlationId,
      outcome: 'succeeded',
    });

    expect(intent.phase).toBe('intent');
    expect(intent).not.toHaveProperty('outcome');
    expect(completion.phase).toBe('completion');
    expect(completion.outcome).toBe('succeeded');
    expect(intent.correlationId).toBe(completion.correlationId);
    expect(intent.eventId).not.toBe(completion.eventId);
  });

  it('gives two flows different correlation ids', () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });

  it('deep-copies the payload, so a later mutation cannot slip past the guard', () => {
    const details = { name: 'Acme Two', previousName: 'Acme' };
    const event = auditEvent({
      type: 'org.renamed',
      actor: ACTOR,
      orgId: ORG_ID,
      subject: AuditSubjects.org(ORG_ID),
      details,
    });

    details.name = 'sk_rag_HqZ2nR8vTx1LmQ7bY4wKpA6dJ0sE3fUgVc9NhX5t';

    expect(event.details.name).toBe('Acme Two');
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

  it('narrows the payload from the type it was given', () => {
    // The return type is the union member rather than the generic record, so a
    // wrapper emitting several types still hands back something that narrows.
    function emit<T extends AuditEventType>(type: T, details: AuditEventDetails[T]) {
      return auditEvent({
        type,
        actor: ACTOR,
        orgId: ORG_ID,
        subject: AuditSubjects.org(ORG_ID),
        details,
      });
    }

    const event = emit('org.renamed', { name: 'Acme Two', previousName: 'Acme' });
    if (event.type !== 'org.renamed') throw new Error('unreachable');
    expect(event.details.previousName).toBe('Acme');
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
    ['accessKeyId', { name: 'Acme', accessKeyId: 'AKIAIOSFODNN7EXAMPLE' }],
    ['keyHash', { name: 'Acme', keyHash: 'deadbeef' }],
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

  it.each([
    ['a Date', { name: 'Acme', at: new Date(NOW) }],
    ['a Set', { name: 'Acme', roles: new Set(['owner']) }],
    ['a Map', { name: 'Acme', roles: new Map() }],
    ['a Buffer', { name: 'Acme', blob: Buffer.from('x') }],
    ['a RegExp', { name: 'Acme', pattern: /x/ }],
    ['a class instance', { name: 'Acme', err: new Error('boom') }],
  ])('refuses %s, which the marshaller cannot store, by field path', (_label, details) => {
    // The alternative is a pathless crash inside the write, with a mutation
    // already staged behind it.
    expect(build(details)).toThrow(ProhibitedAuditContentError);
    expect(build(details)).toThrow(/details\.(at|roles|blob|pattern|err)/);
  });

  it('accepts a nested plain object and a plain array', () => {
    expect(
      build({ name: 'Acme', scope: { region: 'eu-west-1' }, buckets: ['a', 'b'] }),
    ).not.toThrow(
      // Both marshall as maps and lists the viewer reads back unchanged.
    );
  });

  it('redacts a value carrying a full RAG key token rather than refusing the event', () => {
    // The value could be something a customer typed, and in a two-phase flow a
    // throw here would fire after the vendor already minted the credential.
    const event = build({
      name: 'Acme',
      note: 'issued sk_rag_HqZ2nR8vTx1LmQ7bY4wKpA6dJ0sE3fUgVc9NhX5t',
    })();

    expect((event.details as Record<string, string>).note).toBe('[REDACTED]');
  });

  it('lets a key name that starts like a token through untouched', () => {
    // KEY_NAME_PATTERN admits it, so a member may really have named their key
    // this; refusing it would make that customer's own key unauditable.
    const event = build({ name: 'sk_rag_ci' })();

    expect(event.details.name).toBe('sk_rag_ci');
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

  it('runs again at the write, so an event mutated after construction is still caught', async () => {
    ddbMock.reset();
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    const event = renamed();
    (event.details as Record<string, unknown>).secretAccessKey = 'AKIAIOSFODNN7EXAMPLE';

    await expect(commitAudited({ items: [MUTATION], event })).rejects.toThrow(
      ProhibitedAuditContentError,
    );
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it.each(AUDIT_EVENT_TYPES)('lets the payload a %s event actually carries through', (type) => {
    expect(() =>
      auditEvent({
        type,
        actor: ACTOR,
        orgId: ORG_ID,
        subject: AuditSubjects.org(ORG_ID),
        details: DETAILS[type],
      }),
    ).not.toThrow();
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
          // The event-type index. Stamped on every write because DynamoDB
          // populates an index only from items already carrying its keys, so an
          // event written without these is invisible to it for as long as it is
          // stored.
          gsi1pk: { S: `ORG#${ORG_ID}#TYPE#org.renamed` },
          gsi1sk: { S: `${event.createdAt}#${event.eventId}` },
          type: { S: 'org.renamed' },
          orgId: { S: ORG_ID },
          subject: { S: `org:${ORG_ID}` },
          ttl: { N: String(event.ttl) },
        }),
        // Inside a transaction a Put landing on an existing event means a reused
        // event id, which is a bug rather than a retry.
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    });
  });

  it('derives pk and sk from the event, whatever a stored row carried', () => {
    // A record read back and re-put brings its own pk/sk; the keys are built
    // last so they always agree with the event's orgId and timestamp.
    const event = { ...renamed(), pk: 'ORG#somebody-else', sk: 'tampered' } as ReturnType<
      typeof renamed
    >;

    expect(auditPut(event).Put!.Item!.pk).toStrictEqual({ S: `ORG#${ORG_ID}` });
    expect(auditPut(event).Put!.Item!.sk).toStrictEqual({
      S: `${event.createdAt}#${event.eventId}`,
    });
  });

  it('derives the index keys from the event, whatever a stored row carried', () => {
    const event = { ...renamed(), gsi1pk: 'ORG#somebody-else#TYPE#org.created' } as ReturnType<
      typeof renamed
    >;

    expect(auditPut(event).Put!.Item!.gsi1pk).toStrictEqual({
      S: `ORG#${ORG_ID}#TYPE#org.renamed`,
    });
  });

  it('drops a top-level field the envelope does not name', () => {
    // Structural typing accepts an event-shaped value carrying an extra field —
    // a row read back with a legacy attribute, a spread at some call site — and
    // the content guard only ever looks at `details`. The allowlist is what
    // keeps it off the table.
    const event = { ...renamed(), accessKeyId: 'AKIAIOSFODNN7EXAMPLE' } as ReturnType<
      typeof renamed
    >;

    expect(auditPut(event).Put!.Item!.accessKeyId).toBeUndefined();
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the caller’s items and the event as one transaction', async () => {
    const event = renamed();

    await commitAudited({ items: [MUTATION], event });

    const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.TransactItems).toStrictEqual([MUTATION, auditPut(event)]);
  });

  it('carries an idempotency token, so an SDK retry does not re-run the conditions', async () => {
    const event = renamed();

    await commitAudited({ items: [MUTATION], event });

    expect(ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input).toMatchObject({
      ClientRequestToken: event.eventId,
    });
  });

  it('takes a RAG key event with no phase, which is minted in this transaction', async () => {
    const ragKey = auditEvent({
      type: 'key.created',
      actor: ACTOR,
      orgId: ORG_ID,
      subject: AuditSubjects.key('rag', KEY_ID),
      details: { keyKind: 'rag', keyName: 'ci' },
    });

    await commitAudited({ items: [MUTATION], event: ragKey });

    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });

  it('takes the completion half of an S3 key event', async () => {
    const completion = auditEvent({
      type: 'key.created',
      actor: ACTOR,
      orgId: ORG_ID,
      subject: AuditSubjects.key('s3', KEY_ID),
      details: { keyKind: 's3', keyName: 'ci' },
      phase: 'completion',
      correlationId: 'corr-1',
      outcome: 'succeeded',
    });

    await commitAudited({ items: [MUTATION], event: completion });

    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });

  it('will not take an S3 key event with no phase', () => {
    const minted = auditEvent({
      type: 'key.created',
      actor: ACTOR,
      orgId: ORG_ID,
      subject: AuditSubjects.key('s3', KEY_ID),
      details: { keyKind: 's3', keyName: 'ci' },
    });

    // Compiled, never run. The credential is minted at the vendor before any
    // local write, so a row with no phase is a half with nothing to pair it to
    // — and the write it would ride is not what authorized the key.
    const refused = () =>
      commitAudited({
        items: [MUTATION],
        // @ts-expect-error — an unphased vendor-backed key event is not committable.
        event: minted,
      });

    expect(refused).toBeTypeOf('function');
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('composes with a transaction that already spans tables', async () => {
    const billing = {
      Put: { TableName: 'UserInfoTable', Item: { pk: { S: 'x' }, sk: { S: 'y' } } },
    };

    await commitAudited({ items: [MUTATION, billing], event: renamed() });

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
    await expect(commitAudited({ items: [MUTATION], event: renamed() })).rejects.toThrow(
      'AuditTable unavailable',
    );
  });

  it('refuses a transaction the item cap cannot hold, with the count in the message', async () => {
    const items = Array.from({ length: TRANSACT_WRITE_ITEM_LIMIT }, () => MUTATION);

    await expect(commitAudited({ items, event: renamed() })).rejects.toThrow(
      /needs 101 items, 100 is the DynamoDB limit/,
    );
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  describe('when the transaction cancels', () => {
    it('rethrows the cancellation when the caller’s own item failed its condition', async () => {
      ddbMock
        .on(TransactWriteItemsCommand)
        .rejects(cancelledOn(['ConditionalCheckFailed', undefined]));

      // Handlers map this to "that row is gone" — a 404 or a 409 about the
      // entity — so it has to keep arriving as the exception they match on.
      await expect(commitAudited({ items: [MUTATION], event: renamed() })).rejects.toThrow(
        TransactionCanceledException,
      );
    });

    it('raises an audit-side error when only the event item failed', async () => {
      ddbMock
        .on(TransactWriteItemsCommand)
        .rejects(cancelledOn([undefined, 'ConditionalCheckFailed']));

      // Never the caller's mapping: delete-rag-api-key would otherwise report a
      // key that is still live as revoked.
      const failure = commitAudited({ items: [MUTATION], event: renamed() });
      await expect(failure).rejects.toThrow(AuditAppendError);
      await expect(failure).rejects.not.toThrow(TransactionCanceledException);
    });

    it('lands the mutation without its event when the caller says blocking is worse', async () => {
      ddbMock
        .on(TransactWriteItemsCommand)
        .rejectsOnce(cancelledOn([undefined, 'TransactionConflict']))
        .resolves({});

      await commitAudited({
        items: [MUTATION],
        event: renamed(),
        onAuditFailure: 'retry-without-audit',
      });

      const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
      expect(calls).toHaveLength(2);
      expect(calls[1].args[0].input.TransactItems).toStrictEqual([MUTATION]);
      // A fresh token: the retry sends a different item set, and reusing the
      // first one would be rejected as an idempotent-parameter mismatch.
      expect(calls[1].args[0].input.ClientRequestToken).not.toBe(
        calls[0].args[0].input.ClientRequestToken,
      );
    });

    it('lands the mutation when the audit table itself is missing, in that mode', async () => {
      // A deploy that never made the table refuses the whole transaction before
      // any item applies. Rethrowing it strands exactly the mutation the mode
      // exists to protect: the vendor key is already gone and its local row
      // would survive.
      const missingTable = Object.assign(new Error('Requested resource not found'), {
        name: 'ResourceNotFoundException',
      });
      ddbMock.on(TransactWriteItemsCommand).rejectsOnce(missingTable).resolves({});

      await commitAudited({
        items: [MUTATION],
        event: renamed(),
        onAuditFailure: 'retry-without-audit',
      });

      const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
      expect(calls).toHaveLength(2);
      expect(calls[1].args[0].input.TransactItems).toStrictEqual([MUTATION]);
      expect(calls[1].args[0].input.ClientRequestToken).not.toBe(
        calls[0].args[0].input.ClientRequestToken,
      );
    });

    it('lands the mutation when the role may not write the audit table', async () => {
      const denied = Object.assign(new Error('User is not authorized'), {
        name: 'AccessDeniedException',
      });
      ddbMock.on(TransactWriteItemsCommand).rejectsOnce(denied).resolves({});

      await commitAudited({
        items: [MUTATION],
        event: renamed(),
        onAuditFailure: 'retry-without-audit',
      });

      expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(2);
    });

    it('raises when the retry without the event fails too', async () => {
      const missingTable = Object.assign(new Error('Requested resource not found'), {
        name: 'ResourceNotFoundException',
      });
      ddbMock.on(TransactWriteItemsCommand).rejects(missingTable);

      // The refusal may have been about the caller's own table, and the retry
      // is what tells the two apart.
      await expect(
        commitAudited({
          items: [MUTATION],
          event: renamed(),
          onAuditFailure: 'retry-without-audit',
        }),
      ).rejects.toThrow('Requested resource not found');
      expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(2);
    });

    it('still raises an ambiguous failure rather than re-running the mutation', async () => {
      // A timeout or a 5xx may have applied the write; a fresh token would send
      // the caller's items a second time against a table that already holds
      // them.
      const timeout = Object.assign(new Error('socket hang up'), {
        name: 'TimeoutError',
      });
      ddbMock.on(TransactWriteItemsCommand).rejects(timeout);

      await expect(
        commitAudited({
          items: [MUTATION],
          event: renamed(),
          onAuditFailure: 'retry-without-audit',
        }),
      ).rejects.toThrow('socket hang up');
      expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
    });

    it('leaves fail mode raising a missing audit table untouched', async () => {
      const missingTable = Object.assign(new Error('Requested resource not found'), {
        name: 'ResourceNotFoundException',
      });
      ddbMock.on(TransactWriteItemsCommand).rejects(missingTable);

      await expect(commitAudited({ items: [MUTATION], event: renamed() })).rejects.toThrow(
        'Requested resource not found',
      );
      expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
    });

    it('still fails the mutation on a mutation-side cancellation in that mode', async () => {
      ddbMock
        .on(TransactWriteItemsCommand)
        .rejects(cancelledOn(['ConditionalCheckFailed', undefined]));

      await expect(
        commitAudited({
          items: [MUTATION],
          event: renamed(),
          onAuditFailure: 'retry-without-audit',
        }),
      ).rejects.toThrow(TransactionCanceledException);
      expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
    });
  });
});

describe('appendAuditEvent', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(PutItemCommand).resolves({});
  });

  it('puts one event, with no mutation attached and no create-only condition', async () => {
    const event = revokedIntent('corr-1');

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
    });
    // Create-only would turn an SDK retry after a lost response into a failed
    // mutation: the retry collides with the write its first attempt landed.
    expect(calls[0].args[0].input.ConditionExpression).toBeUndefined();
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });
});

describe('twoPhaseAudit', () => {
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  const KEY_ROW = {
    Delete: {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: `ACCESSKEY#${KEY_ID}` } },
    },
  };

  function mintParams() {
    return {
      type: 'key.created' as const,
      actor: ACTOR,
      orgId: ORG_ID,
      // No key id yet — it comes back from the vendor — so both halves are
      // filed under the org and the completion names the key in its details.
      subject: AuditSubjects.org(ORG_ID),
      details: { keyKind: 's3' as const, keyName: 'ci', region: 'eu-west-1' },
      mode: 'fail-closed' as const,
    };
  }

  function revokeParams() {
    return {
      type: 'key.deleted' as const,
      actor: ACTOR,
      orgId: ORG_ID,
      subject: AuditSubjects.key('s3', KEY_ID),
      details: { keyKind: 's3' as const, keyName: 'ci' },
      mode: 'best-effort' as const,
    };
  }

  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function itemOf(call: number) {
    return ddbMock.commandCalls(PutItemCommand)[call].args[0].input.Item!;
  }

  it('writes the intent before the caller touches the vendor', async () => {
    const correlation = await twoPhaseAudit(mintParams());

    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
    expect(itemOf(0)).toMatchObject({
      type: { S: 'key.created' },
      phase: { S: 'intent' },
      correlationId: { S: correlation.correlationId },
      subject: { S: `org:${ORG_ID}` },
    });
    expect(itemOf(0).outcome).toBeUndefined();
  });

  it('closes the correlation on the same subject, with the outcome and the vendor’s id', async () => {
    const correlation = await twoPhaseAudit(mintParams());

    await correlation.complete({
      outcome: 'succeeded',
      details: { keyIdSuffix: 'AMPL' },
      items: [MUTATION],
    });

    const item =
      ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems![1].Put!.Item!;
    expect(item).toMatchObject({
      phase: { S: 'completion' },
      outcome: { S: 'succeeded' },
      correlationId: { S: correlation.correlationId },
      // One subject for both halves, so the viewer can pair them.
      subject: { S: `org:${ORG_ID}` },
    });
    expect(item.details).toMatchObject({
      M: expect.objectContaining({ keyName: { S: 'ci' }, keyIdSuffix: { S: 'AMPL' } }),
    });
  });

  it('closes a correlation that has no local write to ride with', async () => {
    const correlation = await twoPhaseAudit(mintParams());

    // The duplicate-name 409 and the vendor-failure path both return without
    // writing a row, and a dangling intent would say the process died.
    await correlation.complete({ outcome: 'failed' });

    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
    expect(itemOf(1)).toMatchObject({ phase: { S: 'completion' }, outcome: { S: 'failed' } });
  });

  it('aborts a mint whose intent could not be written', async () => {
    ddbMock.on(PutItemCommand).rejects(new Error('AuditTable unavailable'));

    // Fail-closed: no credential may exist at the vendor without a record that
    // somebody asked for it, and the vendor has not been called yet.
    await expect(twoPhaseAudit(mintParams())).rejects.toThrow('AuditTable unavailable');
  });

  it('revokes anyway when the intent could not be written', async () => {
    ddbMock.on(PutItemCommand).rejects(new Error('AuditTable unavailable'));

    // An audit outage must never be the reason a leaked key stays live.
    const correlation = await twoPhaseAudit(revokeParams());

    expect(correlation.correlationId).toEqual(expect.any(String));
    expect(console.error).toHaveBeenCalledWith('[audit] event not recorded', expect.any(Object));
  });

  it('counts a dropped event, so an alarm can watch the rate', async () => {
    ddbMock.on(PutItemCommand).rejects(new Error('AuditTable unavailable'));

    await twoPhaseAudit(revokeParams());

    const emitted = stdoutWrite.mock.calls.map(([line]) => String(line));
    expect(emitted.join('')).toContain('AuditEventDropped');
  });

  it('lands a best-effort revocation whose completion event is refused', async () => {
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejectsOnce(cancelledOn([undefined, 'TransactionConflict']))
      .resolves({});
    const correlation = await twoPhaseAudit(revokeParams());

    await correlation.complete({ outcome: 'succeeded', items: [KEY_ROW] });

    const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.TransactItems).toStrictEqual([KEY_ROW]);
  });

  it('says what the intent said, whatever the caller did with the payload after', async () => {
    const params = mintParams();
    const correlation = await twoPhaseAudit(params);

    // The caller keeps its own object; the completion is built from the copy the
    // intent recorded.
    params.details.keyName = 'not-what-was-asked-for';
    await correlation.complete({ outcome: 'succeeded', details: { keyIdSuffix: 'AMPL' } });

    expect(itemOf(1).details).toMatchObject({
      M: expect.objectContaining({ keyName: { S: 'ci' } }),
    });
  });

  it('refuses a completion that redefines a field the intent recorded', async () => {
    const correlation = await twoPhaseAudit(mintParams());

    // Two records under one correlation id disagreeing about which operation
    // they describe leaves a reader no way to tell which half to believe.
    await expect(
      correlation.complete({ outcome: 'succeeded', details: { keyName: 'something-else' } }),
    ).rejects.toThrow(AuditCompletionConflictError);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
  });

  it('takes a completion that restates a recorded field with the value it has', async () => {
    const correlation = await twoPhaseAudit(mintParams());

    // A caller passing back what it read is not a contradiction.
    await correlation.complete({
      outcome: 'succeeded',
      details: { keyKind: 's3', keyIdSuffix: 'AMPL' },
    });

    expect(itemOf(1).details).toMatchObject({
      M: expect.objectContaining({ keyKind: { S: 's3' }, keyIdSuffix: { S: 'AMPL' } }),
    });
  });

  it('fails a mint whose completion transaction the audit item cancelled', async () => {
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejects(cancelledOn([undefined, 'ConditionalCheckFailed']));
    const correlation = await twoPhaseAudit(mintParams());

    await expect(correlation.complete({ outcome: 'succeeded', items: [MUTATION] })).rejects.toThrow(
      AuditAppendError,
    );
  });
});
