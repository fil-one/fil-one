import { describe, it, expect } from 'vitest';
import {
  AUDIT_ACTOR_KINDS,
  AUDIT_EVENT_PHASES,
  AUDIT_EVENT_TYPES,
  AUDIT_KEY_ID_SUFFIX_LENGTH,
  AUDIT_RETENTION_DAYS,
  PROHIBITED_AUDIT_CONTENT,
  PROHIBITED_AUDIT_FIELD_PATTERNS,
  auditKeyIdSuffix,
  isAuditEventType,
} from './audit.js';

/**
 * The M1 event types, transcribed from the ADR rather than derived from the
 * export — a registry that agrees with itself proves nothing, and the viewer
 * (FIL-1022) is written against this list.
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
  'key.revoked',
];

describe('the event-type registry', () => {
  it('is exactly the M1 set the ADR names', () => {
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
});

describe('retention', () => {
  it('is the PRD quarter', () => {
    expect(AUDIT_RETENTION_DAYS).toBe(90);
  });
});

describe('auditKeyIdSuffix', () => {
  it('keeps only the trailing characters that identify a key in the console', () => {
    expect(auditKeyIdSuffix('ACCESS_KEY_12345EXAMPL')).toBe('AMPL');
    expect(auditKeyIdSuffix('ACCESS_KEY_12345EXAMPL')).toHaveLength(AUDIT_KEY_ID_SUFFIX_LENGTH);
  });

  it('never lengthens a short id into something that looks complete', () => {
    expect(auditKeyIdSuffix('AB')).toBe('AB');
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
  ])('matches the field name %s', (field) => {
    expect(PROHIBITED_AUDIT_FIELD_PATTERNS.some((pattern) => pattern.test(field))).toBe(true);
  });

  it.each([['keyName'], ['keyIdSuffix'], ['orgName'], ['previousName'], ['role'], ['email']])(
    'leaves the field name %s alone',
    (field) => {
      expect(PROHIBITED_AUDIT_FIELD_PATTERNS.some((pattern) => pattern.test(field))).toBe(false);
    },
  );

  it('is frozen, so a caller cannot widen what the write path accepts', () => {
    expect(Object.isFrozen(PROHIBITED_AUDIT_FIELD_PATTERNS)).toBe(true);
  });
});
