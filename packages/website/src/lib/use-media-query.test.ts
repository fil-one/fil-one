import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMediaQuery } from './use-media-query.js';

/** A `matchMedia` whose answer the test flips, firing `change` like a resize would. */
function stubMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return matches;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return (next: boolean) => {
    matches = next;
    listeners.forEach((listener) => listener());
  };
}

describe('useMediaQuery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([true, false])('returns %s when the query currently matches %s', (matches) => {
    stubMatchMedia(matches);
    const { result } = renderHook(() => useMediaQuery('(any-query)'));
    expect(result.current).toBe(matches);
  });

  it('updates when the viewport starts matching the query', () => {
    const setMatches = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(any-query)'));
    act(() => setMatches(true));
    expect(result.current).toBe(true);
  });

  it('returns false where matchMedia is missing', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useMediaQuery('(any-query)'));
    expect(result.current).toBe(false);
  });
});
