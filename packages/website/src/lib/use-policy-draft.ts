import { useEffect, useReducer } from 'react';
import type { PolicyStatement } from '@filone/shared';

import type { BucketPolicySnapshot } from './bucket-policy-api.js';

interface DraftState {
  statements: PolicyStatement[];
  hasUnsavedEdits: boolean;
  /**
   * The ETag the draft was seeded from, so a refetch of the same policy is a
   * no-op. `null` when the bucket has no policy, `undefined` when the policy
   * has not loaded.
   */
  seededEtag: string | null | undefined;
}

type DraftAction =
  | { type: 'seed'; snapshot: BucketPolicySnapshot | null }
  | { type: 'add'; statement: PolicyStatement }
  | { type: 'update'; index: number; statement: PolicyStatement }
  | { type: 'remove'; index: number }
  | { type: 'reset' };

function createSeededState(snapshot: BucketPolicySnapshot | null | undefined): DraftState {
  return {
    statements: snapshot?.policy.Statement ?? [],
    hasUnsavedEdits: false,
    seededEtag: snapshot === undefined ? undefined : (snapshot?.etag ?? null),
  };
}

function reduceDraft(
  state: DraftState,
  action: DraftAction,
  snapshot: BucketPolicySnapshot | null | undefined,
): DraftState {
  switch (action.type) {
    case 'seed':
      return createSeededState(action.snapshot);
    case 'reset':
      return createSeededState(snapshot);
    case 'add':
      return {
        ...state,
        hasUnsavedEdits: true,
        statements: [...state.statements, action.statement],
      };
    case 'update':
      return {
        ...state,
        hasUnsavedEdits: true,
        statements: state.statements.map((s, i) => (i === action.index ? action.statement : s)),
      };
    case 'remove':
      return {
        ...state,
        hasUnsavedEdits: true,
        statements: state.statements.filter((_, i) => i !== action.index),
      };
  }
}

/**
 * A local copy of the bucket's policy statements to edit before saving.
 *
 * The policy is one ETag-versioned document, so every edit lands in the draft
 * and one save writes the whole thing. The draft re-seeds from the snapshot
 * whenever the ETag changes and there are no unsaved edits; a draft with edits
 * survives a refetch.
 */
export function usePolicyDraft(snapshot: BucketPolicySnapshot | null | undefined) {
  const [state, dispatch] = useReducer(
    (s: DraftState, a: DraftAction) => reduceDraft(s, a, snapshot),
    snapshot,
    createSeededState,
  );

  // A new ETag is a new policy. Take it when nothing is unsaved; otherwise
  // the user's edits stand until they save or discard.
  const etag = snapshot === undefined ? undefined : (snapshot?.etag ?? null);
  useEffect(() => {
    if (etag === state.seededEtag || state.hasUnsavedEdits) return;
    dispatch({ type: 'seed', snapshot: snapshot ?? null });
  }, [etag, snapshot, state.hasUnsavedEdits, state.seededEtag]);

  return {
    statements: state.statements,
    hasUnsavedEdits: state.hasUnsavedEdits,
    /** Whether the snapshot has changed since the draft was seeded. */
    isStale: etag !== state.seededEtag && state.hasUnsavedEdits,
    addStatement: (statement: PolicyStatement) => dispatch({ type: 'add', statement }),
    updateStatement: (index: number, statement: PolicyStatement) =>
      dispatch({ type: 'update', index, statement }),
    removeStatement: (index: number) => dispatch({ type: 'remove', index }),
    /** Drop the edits and take the snapshot's statements again. */
    reset: () => dispatch({ type: 'reset' }),
  };
}
