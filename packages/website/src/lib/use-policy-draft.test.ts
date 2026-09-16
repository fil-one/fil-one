import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PolicyStatement } from '@filone/shared';

import { usePolicyDraft } from './use-policy-draft.js';
import type { BucketPolicySnapshot } from './bucket-policy-api.js';

const read: PolicyStatement = { effect: 'allow', principal: ['a'], action: ['s3:GetObject'] };
const write: PolicyStatement = { effect: 'allow', principal: ['b'], action: ['s3:PutObject'] };
const v1: BucketPolicySnapshot = { policy: { statement: [read] }, etag: '"v1"' };
const v2: BucketPolicySnapshot = { policy: { statement: [read, write] }, etag: '"v2"' };

describe('usePolicyDraft', () => {
  it('seeds from the server document and starts clean', () => {
    const { result } = renderHook(() => usePolicyDraft(v1));
    expect(result.current.statements).toStrictEqual([read]);
    expect(result.current.dirty).toBe(false);
  });

  it('edits mark the draft dirty and reset takes the server document back', () => {
    const { result } = renderHook(() => usePolicyDraft(v1));

    act(() => result.current.addStatement(write));
    expect(result.current.statements).toStrictEqual([read, write]);
    expect(result.current.dirty).toBe(true);

    act(() => result.current.updateStatement(0, { ...read, effect: 'deny' }));
    expect(result.current.statements[0]!.effect).toBe('deny');

    act(() => result.current.removeStatement(1));
    expect(result.current.statements).toHaveLength(1);

    act(() => result.current.reset());
    expect(result.current.statements).toStrictEqual([read]);
    expect(result.current.dirty).toBe(false);
  });

  it('takes a new server document when clean, and keeps the draft when dirty', () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: BucketPolicySnapshot | null }) => usePolicyDraft(snapshot),
      { initialProps: { snapshot: v1 } },
    );

    rerender({ snapshot: v2 });
    expect(result.current.statements).toStrictEqual([read, write]);
    expect(result.current.stale).toBe(false);

    act(() => result.current.removeStatement(1));
    rerender({ snapshot: { policy: { statement: [] }, etag: '"v3"' } });
    expect(result.current.statements).toStrictEqual([read]);
    expect(result.current.dirty).toBe(true);
    expect(result.current.stale).toBe(true);

    act(() => result.current.reset());
    expect(result.current.statements).toStrictEqual([]);
    expect(result.current.stale).toBe(false);
  });

  it('treats no policy as an empty draft that a first statement dirties', () => {
    const { result } = renderHook(() => usePolicyDraft(null));
    expect(result.current.statements).toStrictEqual([]);
    act(() => result.current.addStatement(read));
    expect(result.current.dirty).toBe(true);
  });
});
