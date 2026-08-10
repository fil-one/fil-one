import { describe, it, expect } from 'vitest';
import { ApiErrorCode, CSRF_COOKIE_NAME } from '@filone/shared';
import { accountDeletedResponse } from './account-deleted-response.js';

describe('accountDeletedResponse', () => {
  // FIL-112 M6: this used to be 401 from the auth middleware and 410 from the
  // billing handlers. One status, one body shape, one emitter.
  it('is 410 with the ACCOUNT_DELETED code', () => {
    const response = accountDeletedResponse();

    expect(response.statusCode).toBe(410);
    expect(JSON.parse(response.body ?? '{}')).toEqual({
      message: 'Account has been deleted',
      code: ApiErrorCode.ACCOUNT_DELETED,
    });
  });

  // 410 is heuristically cacheable (RFC 9110 §15.1) where the old 401 was not,
  // so a shared proxy could otherwise store this and lock out a user who later
  // signs up again.
  it('forbids caching on every variant', () => {
    expect(accountDeletedResponse().headers?.['Cache-Control']).toBe('no-store');
    expect(accountDeletedResponse({ clearSession: true }).headers?.['Cache-Control']).toBe(
      'no-store',
    );
  });

  it('sets no cookies by default', () => {
    expect(accountDeletedResponse().cookies).toBeUndefined();
    expect(accountDeletedResponse({ clearSession: false }).cookies).toBeUndefined();
  });

  it('clears every auth cookie when clearSession is set, without changing the status', () => {
    const response = accountDeletedResponse({ clearSession: true });

    expect(response.statusCode).toBe(410);
    const cookies = response.cookies ?? [];
    for (const name of [
      'hs_access_token',
      'hs_id_token',
      'hs_refresh_token',
      'hs_logged_in',
      CSRF_COOKIE_NAME,
    ]) {
      expect(cookies).toEqual(expect.arrayContaining([expect.stringContaining(`${name}=;`)]));
    }
    // Max-Age=0 is what actually deletes them.
    for (const cookie of cookies) {
      expect(cookie).toContain('Max-Age=0');
    }
  });
});
