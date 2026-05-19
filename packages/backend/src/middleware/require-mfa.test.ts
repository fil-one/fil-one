import { describe, it, expect } from 'vitest';

import { requireMfa } from './require-mfa.js';
import type { IdTokenClaims } from './auth.js';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';

function buildRequest(claims?: Partial<IdTokenClaims>) {
  const event = buildEvent({ method: 'POST' });
  const internal: Record<string, unknown> = {};
  if (claims) {
    internal.idTokenClaims = {
      email: null,
      emailVerified: false,
      name: null,
      picture: null,
      amr: [],
      ...claims,
    } satisfies IdTokenClaims;
  }
  return buildMiddyRequest(event, { internal });
}

describe('requireMfa', () => {
  it('passes when amr contains "mfa"', async () => {
    const result = await requireMfa().before(buildRequest({ amr: ['mfa'] }));

    expect(result).toBeUndefined();
  });

  it('passes when amr contains "mfa" alongside other methods', async () => {
    const result = await requireMfa().before(buildRequest({ amr: ['pwd', 'mfa'] }));

    expect(result).toBeUndefined();
  });

  it('returns 401 step_up_required when amr is empty', async () => {
    const result = await requireMfa().before(buildRequest({ amr: [] }));

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
  });

  it('returns 401 when amr does not contain "mfa"', async () => {
    const result = await requireMfa().before(buildRequest({ amr: ['pwd'] }));

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
  });

  it('returns 401 when authMiddleware did not stash any claims', async () => {
    const result = await requireMfa().before(buildRequest());

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
  });
});
