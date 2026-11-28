import { afterEach, describe, expect, it, vi } from 'vitest';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { buildSignupLifecycleOutbox } from './lifecycle-outbox.ts';

const signup = { orgId: 'any-org', occurredAt: '2026-11-19T12:00:00.000Z' };

afterEach(() => vi.unstubAllEnvs());

describe('signup lifecycle outbox', () => {
  it('adds no item when lifecycle publishing is disabled', () => {
    vi.stubEnv('FILONE_LIFECYCLE_OUTBOX_TABLE', '');
    expect(buildSignupLifecycleOutbox(signup)).toStrictEqual([]);
  });

  it('writes an immutable stable identity and only the broker contract fields', () => {
    vi.stubEnv('FILONE_LIFECYCLE_OUTBOX_TABLE', 'any-outbox');
    const first = buildSignupLifecycleOutbox({ ...signup, verifiedEmail: 'any-user@EXAMPLE.ORG' });
    const retry = buildSignupLifecycleOutbox({ ...signup, verifiedEmail: 'any-user@EXAMPLE.ORG' });
    expect(first).toStrictEqual(retry);
    expect(first[0].Put).toMatchObject({
      TableName: 'any-outbox',
      ConditionExpression: 'attribute_not_exists(event_id)',
    });
    expect(unmarshall(first[0].Put!.Item!)).toStrictEqual({
      event_id: expect.stringMatching(/^signup_[0-9a-f]{64}$/),
      detail: {
        schema_version: 1,
        event_id: expect.stringMatching(/^signup_[0-9a-f]{64}$/),
        event_type: 'organization.signup',
        occurred_at: signup.occurredAt,
        organization_id: signup.orgId,
        email_domain: 'example.org',
      },
      expires_at: Date.parse(signup.occurredAt) / 1000 + 180 * 86400,
    });
  });

  it.each(['any-user@localhost', 'not-an-email', 'one@two@example.org'])(
    'omits an invalid verified email domain: %s',
    (verifiedEmail) => {
      vi.stubEnv('FILONE_LIFECYCLE_OUTBOX_TABLE', 'any-outbox');
      const [item] = buildSignupLifecycleOutbox({ ...signup, verifiedEmail });
      expect(unmarshall(item.Put!.Item!).detail).toStrictEqual({
        schema_version: 1,
        event_id: expect.stringMatching(/^signup_[0-9a-f]{64}$/),
        event_type: 'organization.signup',
        occurred_at: signup.occurredAt,
        organization_id: signup.orgId,
      });
    },
  );

  it.each([
    { ...signup, orgId: 'user@example.org' }, // Identifiers must not contain email addresses.
    { ...signup, occurredAt: '2026-11-19' }, // No timezone or operation time.
  ])('rejects malformed producer fields: %j', (input) => {
    vi.stubEnv('FILONE_LIFECYCLE_OUTBOX_TABLE', 'any-outbox');
    expect(() => buildSignupLifecycleOutbox(input)).toThrow(/^Invalid lifecycle/);
  });
});
