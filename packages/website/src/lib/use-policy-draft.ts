import { useEffect, useReducer } from 'react';
import type { PolicyStatement } from '@filone/shared';

import type { BucketPolicySnapshot } from './bucket-policy-api.js';

/**
 * The document the tab edits, apart from the one the server holds.
 *
 * The policy is one ETag-versioned document, so every edit lands in a local
 * draft and one save writes the whole thing. The draft re-seeds from the server
 * whenever the ETag changes and the user has no unsaved edits; a dirty draft
 * survives a refetch, which is what lets the conflict alert offer a reload
 * without throwing the user's work away first.
 */
interface DraftState {
  statements: PolicyStatement[];
  dirty: boolean;
  /** The ETag the draft was seeded from, so a refetch of the same document is a no-op. */
  seededFrom: string | null | undefined;
}

type DraftAction =
  | { type: 'seed'; snapshot: BucketPolicySnapshot | null }
  | { type: 'add'; statement: PolicyStatement }
  | { type: 'update'; index: number; statement: PolicyStatement }
  | { type: 'remove'; index: number }
  | { type: 'reset' };

function seeded(snapshot: BucketPolicySnapshot | null | undefined): DraftState {
  return {
    statements: snapshot?.policy.statement ?? [],
    dirty: false,
    seededFrom: snapshot === undefined ? undefined : (snapshot?.etag ?? null),
  };
}

function reduce(
  state: DraftState,
  action: DraftAction,
  snapshot: BucketPolicySnapshot | null | undefined,
): DraftState {
  switch (action.type) {
    case 'seed':
      return seeded(action.snapshot);
    case 'reset':
      return seeded(snapshot);
    case 'add':
      return { ...state, dirty: true, statements: [...state.statements, action.statement] };
    case 'update':
      return {
        ...state,
        dirty: true,
        statements: state.statements.map((s, i) => (i === action.index ? action.statement : s)),
      };
    case 'remove':
      return {
        ...state,
        dirty: true,
        statements: state.statements.filter((_, i) => i !== action.index),
      };
  }
}

export function usePolicyDraft(snapshot: BucketPolicySnapshot | null | undefined) {
  const [state, dispatch] = useReducer(
    (s: DraftState, a: DraftAction) => reduce(s, a, snapshot),
    snapshot,
    seeded,
  );

  // A new ETag is a new document. Take it when nothing is unsaved; otherwise
  // the user's edits stand until they save or discard.
  const etag = snapshot === undefined ? undefined : (snapshot?.etag ?? null);
  useEffect(() => {
    if (etag === state.seededFrom || state.dirty) return;
    dispatch({ type: 'seed', snapshot: snapshot ?? null });
  }, [etag, snapshot, state.dirty, state.seededFrom]);

  return {
    statements: state.statements,
    dirty: state.dirty,
    /** Whether the draft has drifted from the server's document since it was seeded. */
    stale: etag !== state.seededFrom && state.dirty,
    addStatement: (statement: PolicyStatement) => dispatch({ type: 'add', statement }),
    updateStatement: (index: number, statement: PolicyStatement) =>
      dispatch({ type: 'update', index, statement }),
    removeStatement: (index: number) => dispatch({ type: 'remove', index }),
    /** Drop the edits and take the server's document again. */
    reset: () => dispatch({ type: 'reset' }),
  };
}
