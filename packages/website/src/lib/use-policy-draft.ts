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
  | { type: 'seed'; snapshot: BucketPolicySnapshot | null | undefined }
  | { type: 'modify'; statements: PolicyStatement[] };

function createSeededState(snapshot: BucketPolicySnapshot | null | undefined): DraftState {
  return {
    statements: snapshot?.policy.Statement ?? [],
    hasUnsavedEdits: false,
    seededEtag: snapshot === undefined ? undefined : (snapshot?.etag ?? null),
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
 * The policy is one ETag-versioned document, so every edit lands in the draft
 * and one save writes the whole thing. The draft takes a new snapshot only
 * while it has no unsaved edits. It never rebases edits onto a newer policy: a
 * newer ETag arriving over edits makes the draft stale, the caller reports the
 * conflict, and `reset` discards the edits and takes the snapshot.
 */
export function usePolicyDraft(snapshot: BucketPolicySnapshot | null | undefined) {
  const [state, dispatch] = useReducer(reduceDraft, snapshot, createSeededState);

  // A new ETag is a new policy. Take it when nothing is unsaved; otherwise
  // the user's edits stand until they save or discard.
  const etag = snapshot === undefined ? undefined : (snapshot?.etag ?? null);
  useEffect(() => {
    if (etag === state.seededEtag || state.hasUnsavedEdits) return;
    dispatch({ type: 'seed', snapshot });
  }, [etag, snapshot, state.hasUnsavedEdits, state.seededEtag]);

  return {
    statements: state.statements,
    hasUnsavedEdits: state.hasUnsavedEdits,
    /**
     * The ETag of the document the draft was seeded from, which is what a save
     * sends: a write against a newer document the user never saw must lose,
     * even when the query has since refetched it.
     */
    etag: state.seededEtag ?? undefined,
    /** Whether the snapshot has changed since the draft was seeded. */
    isStale: etag !== state.seededEtag && state.hasUnsavedEdits,
    /** Replace the draft's statements; the caller builds the next array. */
    setStatements: (statements: PolicyStatement[]) => dispatch({ type: 'modify', statements }),
    /** Drop the edits and take the snapshot's statements again. */
    reset: () => dispatch({ type: 'seed', snapshot }),
    /**
     * A save landed: seed from what was written, so the draft is clean under
     * the new ETag before the refetch confirms it.
     */
    acceptSaved: (saved: BucketPolicySnapshot | null) =>
      dispatch({ type: 'seed', snapshot: saved }),
  };
}
