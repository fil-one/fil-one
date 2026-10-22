import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiErrorCode } from '@filone/shared';
import {
  defaultRetry,
  isAccountDeleted,
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

describe('isAccountDeleted', () => {
  it('names a deleted account', () => {
    expect(
      isAccountDeleted(Object.assign(new Error(), { code: ApiErrorCode.ACCOUNT_DELETED })),
    ).toBe(true);
  });

  it('leaves every other failure alone', () => {
    expect(isAccountDeleted(Object.assign(new Error(), { status: 410 }))).toBe(false);
    expect(isAccountDeleted(new Error('Failed to fetch'))).toBe(false);
    expect(isAccountDeleted(undefined)).toBe(false);
  });
});

describe('re-reading /me after a request says the session ended', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    queryClient.clear();
  });

  function failWith(queryKey: readonly unknown[], error: unknown): Promise<unknown> {
    return queryClient
      .fetchQuery({ queryKey, queryFn: () => Promise.reject(error), retry: false })
      .catch(() => undefined);
  }

  it('re-reads /me when an ordinary request reports a deleted account', async () => {
    // `api.ts` navigates only when the session probe reports the deletion, and
    // `/me` is cached for ten minutes — so an org another Owner has started
    // deleting would take every panel down under a console that keeps rendering.
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();

    await failWith(
      ['buckets'],
      Object.assign(new Error(), { status: 410, code: ApiErrorCode.ACCOUNT_DELETED }),
    );

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'] });
  });

  it('leaves a deletion reported by /me itself alone', async () => {
    // Invalidating the query that just failed would refetch it, fail again and
    // loop. That response has already sent the tab to /account-deleted.
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();

    await failWith(
      ['me'],
      Object.assign(new Error(), { status: 410, code: ApiErrorCode.ACCOUNT_DELETED }),
    );

    expect(invalidate).not.toHaveBeenCalled();
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
