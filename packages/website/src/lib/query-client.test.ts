import { describe, it, expect } from 'vitest';
import { ApiErrorCode } from '@filone/shared';
import {
  defaultRetry,
  isRoleDenial,
  queryClient,
  queryKeys,
  ME_STALE_TIME,
} from './query-client.js';

describe('defaultRetry', () => {
  it('does not retry on 401', () => {
    expect(defaultRetry(0, Object.assign(new Error(), { status: 401 }))).toBe(false);
  });

  it('does not retry on 403', () => {
    expect(defaultRetry(0, Object.assign(new Error(), { status: 403 }))).toBe(false);
  });

  // The account is gone, so a retry can only fail again.
  it('does not retry on 410', () => {
    expect(defaultRetry(0, Object.assign(new Error(), { status: 410 }))).toBe(false);
  });

  it('retries once on a 500', () => {
    expect(defaultRetry(0, Object.assign(new Error(), { status: 500 }))).toBe(true);
  });

  it('does not retry a second time on a 500', () => {
    expect(defaultRetry(1, Object.assign(new Error(), { status: 500 }))).toBe(false);
  });

  it('retries once on a network error with no status', () => {
    expect(defaultRetry(0, new Error('Failed to fetch'))).toBe(true);
  });

  it('does not retry a second time on a network error', () => {
    expect(defaultRetry(1, new Error('Failed to fetch'))).toBe(false);
  });

  it('retries once on a 404', () => {
    expect(defaultRetry(0, Object.assign(new Error(), { status: 404 }))).toBe(true);
  });
});

describe('isRoleDenial', () => {
  it('names a forbidden role', () => {
    expect(isRoleDenial(Object.assign(new Error(), { code: ApiErrorCode.FORBIDDEN_ROLE }))).toBe(
      true,
    );
  });

  it('names a missing membership', () => {
    expect(isRoleDenial(Object.assign(new Error(), { code: ApiErrorCode.NOT_A_MEMBER }))).toBe(
      true,
    );
  });

  it('leaves every other 403 alone', () => {
    // A grace-period write block is a billing state, not a role one: re-reading
    // `/me` would tell the console nothing new.
    expect(
      isRoleDenial(
        Object.assign(new Error(), { code: ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED, status: 403 }),
      ),
    ).toBe(false);
    expect(isRoleDenial(new Error('Failed to fetch'))).toBe(false);
    expect(isRoleDenial(undefined)).toBe(false);
  });
});

describe('the /me query defaults', () => {
  it('rate-limits the key rather than each hook', () => {
    // Five surfaces observe ['me'], and a query refetches on focus when any one
    // observer thinks it stale — so a single call site registered without a
    // staleTime would refetch `/me` for all of them.
    expect(queryClient.getQueryDefaults(queryKeys.me).staleTime).toBe(ME_STALE_TIME);
  });
});
