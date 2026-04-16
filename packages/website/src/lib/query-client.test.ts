import { describe, it, expect } from 'vitest';
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
});
