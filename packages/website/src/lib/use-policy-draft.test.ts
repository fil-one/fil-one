import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { POLICY_VERSION, buildStatement } from '@filone/shared';
import type { PolicyStatement } from '@filone/shared';

import { usePolicyDraft } from './use-policy-draft.js';
import type { BucketPolicySnapshot } from './bucket-policy-api.js';

const grantGetObjectToPrincipalA = buildStatement({
  bucketName: 'photos',
  principal: ['a'],
  actions: ['s3:GetObject'],
});
const grantPutObjectToPrincipalB = buildStatement({
  bucketName: 'photos',
  principal: ['b'],
  actions: ['s3:PutObject'],
});
const readOnlySnapshot: BucketPolicySnapshot = {
  policy: { Version: POLICY_VERSION, Statement: [grantGetObjectToPrincipalA] },
};
const readWriteSnapshot: BucketPolicySnapshot = {
  policy: {
    Version: POLICY_VERSION,
    Statement: [grantGetObjectToPrincipalA, grantPutObjectToPrincipalB],
  },
};
const emptySnapshot: BucketPolicySnapshot = {
  policy: { Version: POLICY_VERSION, Statement: [] },
};

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

  it('takes the next statements and marks unsaved edits', () => {
    const { result } = renderHook(() => usePolicyDraft(readOnlySnapshot));

    act(() =>
      result.current.setStatements([grantGetObjectToPrincipalA, grantPutObjectToPrincipalB]),
    );

    expect(result.current).toMatchObject({
      statements: [grantGetObjectToPrincipalA, grantPutObjectToPrincipalB],
      hasUnsavedEdits: true,
    });
  });

  it('replaces a statement', () => {
    const { result } = renderHook(() => usePolicyDraft(readWriteSnapshot));
    const denyGetObjectToPrincipalA: PolicyStatement = {
      ...grantGetObjectToPrincipalA,
      Effect: 'Deny',
    };

    act(() =>
      result.current.setStatements([denyGetObjectToPrincipalA, grantPutObjectToPrincipalB]),
    );

    expect(result.current).toMatchObject({
      statements: [denyGetObjectToPrincipalA, grantPutObjectToPrincipalB],
      hasUnsavedEdits: true,
    });
  });

  it('drops a statement', () => {
    const { result } = renderHook(() => usePolicyDraft(readWriteSnapshot));

    act(() => result.current.setStatements([grantPutObjectToPrincipalB]));

    expect(result.current).toMatchObject({
      statements: [grantPutObjectToPrincipalB],
      hasUnsavedEdits: true,
    });
  });

  it("reset takes the snapshot's statements back", () => {
    const { result } = renderHook(() => usePolicyDraft(readOnlySnapshot));
    act(() =>
      result.current.setStatements([grantGetObjectToPrincipalA, grantPutObjectToPrincipalB]),
    );

    act(() => result.current.reset());

    expect(result.current).toMatchObject({
      statements: [grantGetObjectToPrincipalA],
      hasUnsavedEdits: false,
    });
  });

  it('replaces the statements when a changed policy arrives and there are no edits', () => {
    const { result, rerender } = renderWithSnapshot(readOnlySnapshot);

    rerender({ snapshot: readWriteSnapshot });

    expect(result.current).toMatchObject({
      statements: [grantGetObjectToPrincipalA, grantPutObjectToPrincipalB],
      hasUnsavedEdits: false,
    });
  });

  it('keeps the edits when a changed policy arrives with edits', () => {
    const { result, rerender } = renderWithSnapshot(readWriteSnapshot);
    act(() => result.current.setStatements([grantGetObjectToPrincipalA]));

    rerender({ snapshot: emptySnapshot });

    expect(result.current).toMatchObject({
      statements: [grantGetObjectToPrincipalA],
      hasUnsavedEdits: true,
    });
  });

  it('reset after a changed policy arrived takes the latest snapshot', () => {
    const { result, rerender } = renderWithSnapshot(readWriteSnapshot);
    act(() => result.current.setStatements([grantGetObjectToPrincipalA]));
    rerender({ snapshot: emptySnapshot });

    act(() => result.current.reset());

    expect(result.current).toMatchObject({
      statements: [],
      hasUnsavedEdits: false,
    });
  });

  it('starts empty when the bucket has no policy', () => {
    const { result } = renderHook(() => usePolicyDraft(null));

    expect(result.current).toMatchObject({ statements: [], hasUnsavedEdits: false });
  });

  it('adding a statement to an empty draft marks unsaved edits', () => {
    const { result } = renderHook(() => usePolicyDraft(null));

    act(() => result.current.setStatements([grantGetObjectToPrincipalA]));

    expect(result.current).toMatchObject({
      statements: [grantGetObjectToPrincipalA],
      hasUnsavedEdits: true,
    });
  });
});
