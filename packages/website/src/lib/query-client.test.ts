import { describe, it, expect } from 'vitest';
import { ApiErrorCode } from '@filone/shared';
import { defaultRetry } from './query-client.js';

describe('defaultRetry', () => {
  it('does not retry on 401', () => {
    expect(defaultRetry(0, Object.assign(new Error(), { status: 401 }))).toBe(false);
  });

  it('does not retry on 403', () => {
    expect(defaultRetry(0, Object.assign(new Error(), { status: 403 }))).toBe(false);
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

  it('does not retry ACCOUNT_DELETED — the condition is not transient, so a retry gets the same answer', () => {
    expect(
      defaultRetry(
        0,
        Object.assign(new Error(), { status: 410, code: ApiErrorCode.ACCOUNT_DELETED }),
      ),
    ).toBe(false);
  });

  it('still retries a 410 that is not ACCOUNT_DELETED', () => {
    // 410 also carries "the deletion code expired"; only the code is decisive.
    expect(
      defaultRetry(
        0,
        Object.assign(new Error(), {
          status: 410,
          code: ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED,
        }),
      ),
    ).toBe(true);
  });
});
