import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { usePermittedDialog } from './use-permitted-dialog.js';

describe('usePermittedDialog', () => {
  it('keeps a flag open while the permission holds', () => {
    const { result } = renderHook(() => usePermittedDialog(false, true));

    act(() => result.current[1](true));

    expect(result.current[0]).toBe(true);
  });

  it('closes a flag when the permission goes false', async () => {
    let permitted = true;
    const { result, rerender } = renderHook(() => usePermittedDialog(false, permitted));
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);

    permitted = false;
    rerender();

    await waitFor(() => expect(result.current[0]).toBe(false));
  });

  it('closes a dialog that carries its target, back to the closed value', async () => {
    let permitted = true;
    const { result, rerender } = renderHook(() =>
      usePermittedDialog<string | null>(null, permitted),
    );
    act(() => result.current[1]('my-bucket'));
    expect(result.current[0]).toBe('my-bucket');

    permitted = false;
    rerender();

    await waitFor(() => expect(result.current[0]).toBeNull());
  });

  // The gate on the RAG bucket confirmation depends on what it holds: indexing
  // is `buckets.create`, un-indexing is `buckets.delete`.
  it('reads a per-target gate against the value the dialog holds', async () => {
    const mayOpen = (name: string | null) => name === 'allowed';
    const { result } = renderHook(() => usePermittedDialog<string | null>(null, mayOpen));

    act(() => result.current[1]('allowed'));
    expect(result.current[0]).toBe('allowed');

    act(() => result.current[1]('refused'));

    await waitFor(() => expect(result.current[0]).toBeNull());
  });

  // The predicate is asked about an open dialog only, so a call site whose gate
  // reads its target does not have to answer for the closed value.
  it('does not consult a per-target gate while closed', () => {
    const calls: (string | null)[] = [];
    renderHook(() =>
      usePermittedDialog<string | null>(null, (value) => {
        calls.push(value);
        return true;
      }),
    );

    expect(calls).toEqual([]);
  });
});
