import { describe, it, expect } from 'vitest';
import {
  AUDIT_ACTOR_KINDS,
  AUDIT_EVENT_PHASES,
  AUDIT_EVENT_TYPES,
  AUDIT_KEY_ID_SUFFIX_LENGTH,
  AUDIT_OUTCOMES,
  AUDIT_RETENTION_DAYS,
  PROHIBITED_AUDIT_CONTENT,
  PROHIBITED_AUDIT_FIELD_PATTERNS,
  TWO_PHASE_AUDIT_EVENT_TYPES,
  auditKeyIdSuffix,
  isAuditEventType,
  looksLikeCredential,
} from './audit.js';
import { RAG_KEY_DISPLAY_PREFIX_LENGTH } from './api/rag-api-keys.js';

/**
 * Every event type the ADRs name, transcribed from them rather than derived
 * from the export — a registry that agrees with itself proves nothing, and the
 * viewer is written against this list.
 *
 * The first ten are M1's write path. `audit.exported` is the audit log v1 ADR's
 * addition and the only one written on a read path.
 */
const ADR_EVENT_TYPES = [
  'org.created',
  'org.renamed',
  'member.invited',
  'invite.revoked',
  'invite.accepted',
  'member.role_changed',
  'member.removed',
  'ownership.transferred',
  'key.created',
  'key.deleted',
  'audit.exported',
];

describe('the event-type registry', () => {
  it('is exactly the set the ADRs name', () => {
    expect([...AUDIT_EVENT_TYPES]).toStrictEqual(ADR_EVENT_TYPES);
  });

  it('names each type once', () => {
    expect(new Set(AUDIT_EVENT_TYPES).size).toBe(AUDIT_EVENT_TYPES.length);
  });

  it.each(ADR_EVENT_TYPES)('recognizes %s', (type) => {
    expect(isAuditEventType(type)).toBe(true);
  });

  it.each([['org.deleted'], ['member.created'], ['com.filone.iam.member.created.v1'], ['']])(
    'rejects %s',
    (type) => {
      expect(isAuditEventType(type)).toBe(false);
    },
  );

  it('types the actor from the first event, so SSO adds a kind rather than a schema', () => {
    expect([...AUDIT_ACTOR_KINDS]).toStrictEqual(['user', 'system', 'connection']);
  });

  it('gives a two-phase event its two halves and nothing else', () => {
    expect([...AUDIT_EVENT_PHASES]).toStrictEqual(['intent', 'completion']);
  });

  it('marks only the vendor-backed key flows as two-phase', () => {
    expect([...TWO_PHASE_AUDIT_EVENT_TYPES]).toStrictEqual(['key.created', 'key.deleted']);
    for (const type of TWO_PHASE_AUDIT_EVENT_TYPES) {
      expect(AUDIT_EVENT_TYPES).toContain(type);
    }
  });

  it('names the key-removal event what the dashboard calls it', () => {
    // KeyActivity (api/dashboard.ts) derives its action from this union, so the
    // activity feed and the audit log cannot end up with two names for it.
    expect(isAuditEventType('key.deleted')).toBe(true);
    expect(isAuditEventType('key.revoked')).toBe(false);
  });

  it('closes a completion with one of three outcomes', () => {
    expect([...AUDIT_OUTCOMES]).toStrictEqual(['succeeded', 'failed', 'noop']);
  });
});

describe('retention', () => {
  it('is the PRD quarter', () => {
    expect(AUDIT_RETENTION_DAYS).toBe(90);
  });
});

describe('auditKeyIdSuffix', () => {
  it('keeps the trailing characters of an access key id, which the console shows in full', () => {
    expect(auditKeyIdSuffix('s3', 'ACCESS_KEY_12345EXAMPL')).toBe('AMPL');
    expect(auditKeyIdSuffix('s3', 'ACCESS_KEY_12345EXAMPL')).toHaveLength(
      AUDIT_KEY_ID_SUFFIX_LENGTH,
    );
  });

  it('keeps the leading display prefix of a RAG key, which is what the console lists', () => {
    // Four trailing characters of a random token match nothing on screen; the
    // prefix is the string RagPipelineKeysTab renders beside the key's name.
    expect(auditKeyIdSuffix('rag', 'sk_rag_AbC12rest-of-the-token')).toBe('sk_rag_AbC12');
    expect(auditKeyIdSuffix('rag', 'sk_rag_AbC12rest-of-the-token')).toHaveLength(
      RAG_KEY_DISPLAY_PREFIX_LENGTH,
    );
  });

  it('never lengthens a short id into something that looks complete', () => {
    expect(auditKeyIdSuffix('s3', 'AB')).toBe('AB');
    expect(auditKeyIdSuffix('rag', 'AB')).toBe('AB');
  });
});

describe('the prohibited-content list', () => {
  it('names the credential classes this product actually mints', () => {
    expect(PROHIBITED_AUDIT_CONTENT).toContain(
      'secret access keys and the full access key id they pair with',
    );
    expect(PROHIBITED_AUDIT_CONTENT).toContain('RAG API key tokens and their hashes');
    expect(PROHIBITED_AUDIT_CONTENT).toContain('invitation tokens and the URLs that carry them');
  });

  it.each([
    ['secretAccessKey'],
    ['SECRET'],
    ['password'],
    ['passphrase'],
    ['tokenHash'],
    ['refresh_token'],
    ['credentials'],
    ['Cookie'],
    ['bearerToken'],
    ['authorization'],
    ['private_key'],
    ['privateKey'],
    ['recoveryCode'],
    ['recovery-code'],
    ['presignedUrl'],
    ['signed_url'],
    ['cardNumber'],
    ['accountNumber'],
    // The credentials this product mints, by the names the code already gives
    // them: an event carrying any of these is a developer mistake, not data.
    ['accessKeyId'],
    ['access_key_id'],
    ['keyHash'],
    ['apiKey'],
    ['signature'],
    ['sessionId'],
    ['csrfToken'],
  ])('matches the field name %s', (field) => {
    expect(PROHIBITED_AUDIT_FIELD_PATTERNS.some((pattern) => pattern.test(field))).toBe(true);
  });

  it.each([
    ['keyName'],
    ['keyIdSuffix'],
    ['keyKind'],
    ['orgName'],
    ['previousName'],
    ['role'],
    ['email'],
    ['region'],
    ['recovered'],
  ])('leaves the field name %s alone', (field) => {
    expect(PROHIBITED_AUDIT_FIELD_PATTERNS.some((pattern) => pattern.test(field))).toBe(false);
  });

  it('is frozen, so a caller cannot widen what the write path accepts', () => {
    expect(Object.isFrozen(PROHIBITED_AUDIT_FIELD_PATTERNS)).toBe(true);
  });
});

describe('looksLikeCredential', () => {
  it.each([
    ['a full RAG bearer token', 'sk_rag_HqZ2nR8vTx1LmQ7bY4wKpA6dJ0sE3fUgVc9NhX5t'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a SHA-256 digest', 'a'.repeat(63) + '0'],
    ['a presigned URL', 'https://example.com/o?X-Amz-Signature=deadbeef'],
    ['a URL carrying an invitation token', 'https://app.filone.com/join?invite_token=abc'],
    ['a random base64 blob', 'Zm9vYmFyQmF6MTIzNDU2Nzg5MFF1dXhDb3JnZUdyYXVsdA'],
  ])('sees %s', (_label, value) => {
    expect(looksLikeCredential(value)).toBe(true);
  });

  it.each([
    // The finding this rule exists for: KEY_NAME_PATTERN admits a name that
    // starts with the token prefix, and the RAG display prefix the console
    // renders IS the token's first twelve characters. Refusing either would
    // make a customer's own key unauditable.
    ['a key named after the token prefix', 'sk_rag_ci'],
    ['the display prefix the console shows', 'sk_rag_AbC12'],
    ['an org name', 'Acme Manufacturing Co.'],
    ['an email', 'owner@example.com'],
    ['a UUID', '11111111-2222-3333-4444-555555555555'],
    ['the trailing four of an access key id', 'AMPL'],
    ['a long name with spaces', 'The Very Long Organization Name That Someone Actually Typed'],
  ])('leaves %s alone', (_label, value) => {
    expect(looksLikeCredential(value)).toBe(false);
  });
});
