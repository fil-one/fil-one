import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFolderSearch } from './use-folder-search.js';

describe('useFolderSearch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A search typed and settled in `any-folder/`, ready for the next step. */
  function renderSettledSearch() {
    const hook = renderHook(({ prefix }) => useFolderSearch(prefix), {
      initialProps: { prefix: 'any-folder/' },
    });
    act(() => hook.result.current.setText('any-search'));
    act(() => {
      vi.runAllTimers();
    });
    return hook;
  }

  it('keeps the settled text behind the typed text until typing pauses', () => {
    const { result } = renderHook(() => useFolderSearch('any-folder/'));

    act(() => result.current.setText('any-search'));

    expect(result.current).toMatchObject({ text: 'any-search', settledText: '' });
  });

  it('settles the typed text once typing pauses', () => {
    const { result } = renderSettledSearch();

    expect(result.current).toMatchObject({ text: 'any-search', settledText: 'any-search' });
  });

  it('empties the box and the listed search on the first render in another folder', () => {
    const { result, rerender } = renderSettledSearch();

    rerender({ prefix: 'any-other-folder/' });

    expect(result.current).toMatchObject({ text: '', settledText: '' });
  });
});
