import { describe, it, expect, vi } from 'vitest';

import { settleAll } from './settle-all.js';

describe('settleAll', () => {
  it('runs every task and resolves when they all succeed', async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);

    await settleAll(
      [
        { name: 'a', run: a },
        { name: 'b', run: b },
      ],
      (names) => `failed: ${names}`,
    );

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('attempts the later tasks even after an earlier one rejects, then names the failures', async () => {
    const later = vi.fn().mockResolvedValue(undefined);

    const err = (await settleAll(
      [
        { name: 'first', run: () => Promise.reject(new Error('boom')) },
        { name: 'later', run: later },
      ],
      (names) => `failed: ${names}`,
    ).catch((e: unknown) => e)) as AggregateError;

    expect(later).toHaveBeenCalled();
    expect(err).toBeInstanceOf(AggregateError);
    expect(err.message).toBe('failed: first');
    expect(err.errors.map(String).join()).toMatch(/boom/);
  });

  it('a SYNCHRONOUS throw is contained, not allowed to skip the remaining tasks', async () => {
    // `tasks.map(({ run }) => run())` would let this escape before
    // Promise.allSettled is ever reached, so `later` would never run — the
    // exact failure this helper exists to prevent. Unreachable while every
    // caller passes an async function; guarded structurally rather than by
    // convention because a destructive path relies on it.
    const later = vi.fn().mockResolvedValue(undefined);

    const err = (await settleAll(
      [
        {
          name: 'sync-thrower',
          run: (): Promise<void> => {
            throw new Error('thrown before any await');
          },
        },
        { name: 'later', run: later },
      ],
      (names) => `failed: ${names}`,
    ).catch((e: unknown) => e)) as AggregateError;

    expect(later).toHaveBeenCalled();
    expect(err.message).toBe('failed: sync-thrower');
  });
});
