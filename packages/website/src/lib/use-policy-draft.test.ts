import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PolicyStatement } from '@filone/shared';

import { usePolicyDraft } from './use-policy-draft.js';
import type { BucketPolicySnapshot } from './bucket-policy-api.js';

const grantGetObjectToPrincipalA: PolicyStatement = {
  Effect: 'Allow',
  Principal: ['a'],
  Action: ['s3:GetObject'],
};
const grantPutObjectToPrincipalB: PolicyStatement = {
  Effect: 'Allow',
  Principal: ['b'],
  Action: ['s3:PutObject'],
};
const readOnlySnapshot: BucketPolicySnapshot = {
  policy: { Statement: [grantGetObjectToPrincipalA] },
  etag: '"v1"',
};
const readWriteSnapshot: BucketPolicySnapshot = {
  policy: { Statement: [grantGetObjectToPrincipalA, grantPutObjectToPrincipalB] },
  etag: '"v2"',
};
const emptySnapshot: BucketPolicySnapshot = { policy: { Statement: [] }, etag: '"v3"' };

function renderWithSnapshot(snapshot: BucketPolicySnapshot | null) {
  return renderHook(
    ({ snapshot }: { snapshot: BucketPolicySnapshot | null }) => usePolicyDraft(snapshot),
    { initialProps: { snapshot } },
  );
}

describe('usePolicyDraft', () => {
  it("starts with the snapshot's statements and no unsaved edits", () => {
    const { result } = renderHook(() => usePolicyDraft(readOnlySnapshot));

    expect(result.current).toMatchObject({
      statements: [grantGetObjectToPrincipalA],
      hasUnsavedEdits: false,
    });
  });

  it('adds a statement and marks unsaved edits', () => {
    const { result } = renderHook(() => usePolicyDraft(readOnlySnapshot));

    act(() => result.current.addStatement(grantPutObjectToPrincipalB));

    expect(result.current).toMatchObject({
      statements: [grantGetObjectToPrincipalA, grantPutObjectToPrincipalB],
      hasUnsavedEdits: true,
    });
  });

  it('updates a statement', () => {
    const { result } = renderHook(() => usePolicyDraft(readWriteSnapshot));
    const denyGetObjectToPrincipalA: PolicyStatement = {
      ...grantGetObjectToPrincipalA,
      Effect: 'Deny',
    };

    act(() => result.current.updateStatement(0, denyGetObjectToPrincipalA));

    expect(result.current).toMatchObject({
      statements: [denyGetObjectToPrincipalA, grantPutObjectToPrincipalB],
      hasUnsavedEdits: true,
    });
  });

  it('removes a statement', () => {
    const { result } = renderHook(() => usePolicyDraft(readWriteSnapshot));

    act(() => result.current.removeStatement(0));

    expect(result.current).toMatchObject({
      statements: [grantPutObjectToPrincipalB],
      hasUnsavedEdits: true,
    });
  });

  it("reset takes the snapshot's statements back", () => {
    const { result } = renderHook(() => usePolicyDraft(readOnlySnapshot));
    act(() => result.current.addStatement(grantPutObjectToPrincipalB));

    act(() => result.current.reset());

    expect(result.current).toMatchObject({
      statements: [grantGetObjectToPrincipalA],
      hasUnsavedEdits: false,
    });
  });

  it('replaces the statements when a new ETag arrives and there are no edits', () => {
    const { result, rerender } = renderWithSnapshot(readOnlySnapshot);

    rerender({ snapshot: readWriteSnapshot });

    expect(result.current).toMatchObject({
      statements: [grantGetObjectToPrincipalA, grantPutObjectToPrincipalB],
      hasUnsavedEdits: false,
      isStale: false,
    });
  });

  it('leaves the draft unchanged on a refetch with the same ETag', () => {
    const { result, rerender } = renderWithSnapshot(readOnlySnapshot);

    rerender({ snapshot: { ...emptySnapshot, etag: readOnlySnapshot.etag } });

    expect(result.current.statements).toStrictEqual([grantGetObjectToPrincipalA]);
  });

  it('keeps the edits and sets isStale when a new ETag arrives with edits', () => {
    const { result, rerender } = renderWithSnapshot(readWriteSnapshot);
    act(() => result.current.removeStatement(1));

    rerender({ snapshot: emptySnapshot });

    expect(result.current).toMatchObject({
      statements: [grantGetObjectToPrincipalA],
      hasUnsavedEdits: true,
      isStale: true,
    });
  });

  it('reset after isStale takes the latest snapshot', () => {
    const { result, rerender } = renderWithSnapshot(readWriteSnapshot);
    act(() => result.current.removeStatement(1));
    rerender({ snapshot: emptySnapshot });

    act(() => result.current.reset());

    expect(result.current).toMatchObject({
      statements: [],
      hasUnsavedEdits: false,
      isStale: false,
    });
  });

  it('starts empty when the bucket has no policy', () => {
    const { result } = renderHook(() => usePolicyDraft(null));

    expect(result.current).toMatchObject({ statements: [], hasUnsavedEdits: false });
  });

  it('adding a statement to an empty draft marks unsaved edits', () => {
    const { result } = renderHook(() => usePolicyDraft(null));

    act(() => result.current.addStatement(grantGetObjectToPrincipalA));

    expect(result.current).toMatchObject({
      statements: [grantGetObjectToPrincipalA],
      hasUnsavedEdits: true,
    });
  });
});
