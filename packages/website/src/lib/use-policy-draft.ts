import { useEffect, useReducer } from 'react';
import type { PolicyStatement } from '@filone/shared';

import type { BucketPolicySnapshot } from './bucket-policy-api.js';

interface DraftState {
  statements: PolicyStatement[];
  hasUnsavedEdits: boolean;
  /**
   * The snapshot the draft was seeded from, so a refetch of the same policy is
   * a no-op. `null` when the bucket has no policy, `undefined` when the policy
   * has not loaded.
   */
  seededFrom: BucketPolicySnapshot | null | undefined;
}

type DraftAction =
  | { type: 'seed'; snapshot: BucketPolicySnapshot | null | undefined }
  | { type: 'modify'; statements: PolicyStatement[] };

function createSeededState(snapshot: BucketPolicySnapshot | null | undefined): DraftState {
  return {
    statements: snapshot?.policy.Statement ?? [],
    hasUnsavedEdits: false,
    seededFrom: snapshot,
  };
}

function reduceDraft(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'seed':
      return createSeededState(action.snapshot);
    case 'modify':
      return { ...state, hasUnsavedEdits: true, statements: action.statements };
  }
}

/**
 * A local copy of the bucket's policy statements to edit before saving.
 *
 * The policy is one document, so every edit lands in the draft and one save
 * writes the whole thing; the last save wins. The draft takes a new snapshot
 * only while it has no unsaved edits. A policy that changes under unsaved
 * edits leaves them in place, and `reset` discards them and takes the
 * snapshot.
 */
export function usePolicyDraft(snapshot: BucketPolicySnapshot | null | undefined) {
  const [state, dispatch] = useReducer(reduceDraft, snapshot, createSeededState);

  // react-query keeps the previous object when a refetch returns an equal
  // document, so a new object is a changed policy. Take it when nothing is
  // unsaved; otherwise the user's edits stand until they save or discard.
  useEffect(() => {
    if (snapshot === state.seededFrom || state.hasUnsavedEdits) return;
    dispatch({ type: 'seed', snapshot });
  }, [snapshot, state.hasUnsavedEdits, state.seededFrom]);

  return {
    statements: state.statements,
    hasUnsavedEdits: state.hasUnsavedEdits,
    /** Replace the draft's statements; the caller builds the next array. */
    setStatements: (statements: PolicyStatement[]) => dispatch({ type: 'modify', statements }),
    /** Drop the edits and take the snapshot's statements again. */
    reset: () => dispatch({ type: 'seed', snapshot }),
    /**
     * A save or removal landed: seed from what was written, so the draft is
     * clean before the refetch confirms it.
     */
    acceptSaved: (saved: BucketPolicySnapshot | null) =>
      dispatch({ type: 'seed', snapshot: saved }),
  };
}
