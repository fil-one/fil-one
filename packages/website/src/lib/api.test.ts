import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiErrorCode } from '@filone/shared';

const mockFetch = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * `apiRequest` navigates by assigning `window.location.href`, which jsdom
 * cannot perform. Swap in a plain object carrying the real location's fields
 * so the assignment is observable and `env.ts`'s stage inference (which reads
 * `hostname` at import time) still sees a real value.
 */
function stubLocation(): { current: Location } {
  const real = window.location;
  const stub = {
    href: real.href,
    hostname: real.hostname,
    origin: real.origin,
    assign: vi.fn(),
  } as unknown as Location;
  Object.defineProperty(window, 'location', { configurable: true, value: stub });
  return { current: stub };
}

/**
 * A fresh module instance per test: `api.ts` keeps a module-level
 * `isRedirecting` latch that suppresses every redirect after the first.
 */
async function freshApi() {
  vi.resetModules();
  return import('./api.js');
}

describe('apiRequest ACCOUNT_DELETED handling', () => {
  let location: { current: Location };
  let realLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    realLocation = window.location;
    location = stubLocation();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('redirects to /account-deleted when the session probe returns a 410 ACCOUNT_DELETED', async () => {
    mockFetch.mockImplementation(() =>
      jsonResponse(410, {
        message: 'Account has been deleted',
        code: ApiErrorCode.ACCOUNT_DELETED,
      }),
    );
    const { apiRequest } = await freshApi();

    await expect(apiRequest('/me')).rejects.toMatchObject({
      status: 410,
      code: ApiErrorCode.ACCOUNT_DELETED,
    });
    expect(location.current.href).toBe('/account-deleted');
  });

  it('redirects on a session-probe ACCOUNT_DELETED whatever status carries it', async () => {
    // The condition is identified by the code alone; the status is transport.
    mockFetch.mockImplementation(() =>
      jsonResponse(401, {
        message: 'Account has been deleted',
        code: ApiErrorCode.ACCOUNT_DELETED,
      }),
    );
    const { apiRequest } = await freshApi();

    await expect(apiRequest('/me')).rejects.toMatchObject({
      code: ApiErrorCode.ACCOUNT_DELETED,
    });
    expect(location.current.href).toBe('/account-deleted');
  });

  it('still redirects when the probe carries a query string', async () => {
    // getMe() appends ?forceRefresh=1 / ?include=mfa — still the session probe.
    mockFetch.mockImplementation(() =>
      jsonResponse(410, {
        message: 'Account has been deleted',
        code: ApiErrorCode.ACCOUNT_DELETED,
      }),
    );
    const { apiRequest } = await freshApi();

    await expect(apiRequest('/me?include=mfa')).rejects.toMatchObject({
      code: ApiErrorCode.ACCOUNT_DELETED,
    });
    expect(location.current.href).toBe('/account-deleted');
  });

  it('throws but does not navigate when a non-probe endpoint returns ACCOUNT_DELETED', async () => {
    // Five backend handlers emit this code off the `deleting` fence, which an
    // org can carry with no deletion ever having completed. Navigating there
    // would evict a live, paying user onto a page saying their account is
    // gone — while their cookies still work. Only the session probe may
    // navigate; everyone else renders the error inline.
    const before = location.current.href;
    mockFetch.mockImplementation(() =>
      jsonResponse(410, {
        message: 'Account has been deleted',
        code: ApiErrorCode.ACCOUNT_DELETED,
      }),
    );
    const { apiRequest } = await freshApi();

    await expect(apiRequest('/access-keys', { method: 'POST' })).rejects.toMatchObject({
      status: 410,
      code: ApiErrorCode.ACCOUNT_DELETED,
    });
    // The /me/... family are ordinary endpoints, not the identity probe.
    await expect(apiRequest('/me/profile', { method: 'PATCH' })).rejects.toMatchObject({
      code: ApiErrorCode.ACCOUNT_DELETED,
    });
    expect(location.current.href).toBe(before);
  });

  it('does not redirect on a 410 that means the deletion code expired', async () => {
    const before = location.current.href;
    mockFetch.mockImplementation(() =>
      jsonResponse(410, {
        message: 'Verification code expired',
        code: ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED,
      }),
    );
    const { apiRequest } = await freshApi();

    await expect(apiRequest('/account/delete', { method: 'POST' })).rejects.toMatchObject({
      status: 410,
      code: ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED,
    });
    expect(location.current.href).toBe(before);
  });

  it('still raises StepUpRequiredError for a 401 step_up_required', async () => {
    mockFetch.mockImplementation(() => jsonResponse(401, { error: 'step_up_required' }));
    const { apiRequest, StepUpRequiredError } = await freshApi();

    await expect(apiRequest('/mfa/recovery-code/regenerate', { method: 'POST' })).rejects.toThrow(
      StepUpRequiredError,
    );
  });

  it('still redirects a plain 401 to login', async () => {
    mockFetch.mockImplementation(() => jsonResponse(401, { message: 'Unauthorized' }));
    const { apiRequest } = await freshApi();

    await expect(apiRequest('/me')).rejects.toMatchObject({ status: 401 });
    expect(location.current.href).toContain('/login');
  });

  it('leaves an unrelated error status on the generic path', async () => {
    const before = location.current.href;
    mockFetch.mockImplementation(() => jsonResponse(500, { message: 'Internal error' }));
    const { apiRequest } = await freshApi();

    await expect(apiRequest('/me')).rejects.toMatchObject({ status: 500 });
    expect(location.current.href).toBe(before);
  });

  it('survives a non-JSON error body — the pre-check sits on every non-ok response', async () => {
    // Gateway/CDN failures answer with HTML or nothing at all. The ACCOUNT_DELETED
    // pre-check parses a clone, so an unparseable body must fall through to the
    // generic path with the original body still readable by it.
    const before = location.current.href;
    mockFetch.mockImplementation(
      () =>
        new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    const { apiRequest } = await freshApi();

    await expect(apiRequest('/me')).rejects.toMatchObject({
      status: 502,
      message: 'Request failed with status 502',
    });
    expect(location.current.href).toBe(before);
  });

  it('survives an empty error body', async () => {
    const before = location.current.href;
    mockFetch.mockImplementation(() => new Response(null, { status: 503 }));
    const { apiRequest } = await freshApi();

    await expect(apiRequest('/me')).rejects.toMatchObject({ status: 503 });
    expect(location.current.href).toBe(before);
  });
});
