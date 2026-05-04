import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDecodeJwt = vi.fn();
vi.mock('jose', () => ({
  decodeJwt: (token: unknown) => mockDecodeJwt(token),
}));

import { requireMfa } from './require-mfa.js';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';

function buildRequest(claims?: Record<string, unknown>) {
  if (claims !== undefined) {
    mockDecodeJwt.mockReturnValueOnce(claims);
  }
  const event = buildEvent({ cookies: ['hs_id_token=id-token'], method: 'POST' });
  return buildMiddyRequest(event);
}

describe('requireMfa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when amr contains "mfa"', async () => {
    const result = await requireMfa().before(buildRequest({ amr: ['mfa'] }));

    expect(result).toBeUndefined();
  });

  it('passes when amr contains "mfa" alongside other methods', async () => {
    const result = await requireMfa().before(buildRequest({ amr: ['pwd', 'mfa'] }));

    expect(result).toBeUndefined();
  });

  it('returns 401 step_up_required when amr is missing', async () => {
    const result = await requireMfa().before(buildRequest({}));

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

  it('returns 401 when amr is not an array', async () => {
    const result = await requireMfa().before(buildRequest({ amr: 'mfa' }));

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
  });

  it('returns 401 when id_token cookie is missing', async () => {
    const event = buildEvent({ method: 'POST' });
    const result = await requireMfa().before(buildMiddyRequest(event));

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
  });

  it('returns 401 when decodeJwt throws', async () => {
    mockDecodeJwt.mockImplementationOnce(() => {
      throw new Error('malformed');
    });
    const event = buildEvent({ cookies: ['hs_id_token=garbage'], method: 'POST' });
    const result = await requireMfa().before(buildMiddyRequest(event));

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
  });
});
