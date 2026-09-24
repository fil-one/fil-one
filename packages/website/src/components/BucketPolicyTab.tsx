import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, ShieldCheckIcon } from '@phosphor-icons/react/dist/ssr';
import type { PolicyStatement, S3Region } from '@filone/shared';

import { isPolicyConflict } from '../lib/bucket-policy-api.js';
import { listMembers } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { useBucketPolicy } from '../lib/use-bucket-policy.js';
import { getMemberNameLookup } from '../lib/use-member-scope.js';
import { usePolicyDraft } from '../lib/use-policy-draft.js';
import { Alert } from './Alert.js';
import { Button } from './Button.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { EmptyStateCard } from './EmptyStateCard.js';
import { Heading } from './Heading/Heading.js';
import { PolicyStatementCard } from './PolicyStatementCard.js';
import { PolicyStatementModal, isDenyForEveryone } from './PolicyStatementModal.js';
import { SlowOperationIndicator } from './SlowOperationIndicator.js';
import { Spinner } from './Spinner.js';
import { useToast } from './Toast/index.js';

export type BucketPolicyTabProps = {
  bucketName: string;
  region: S3Region;
};

/** Which statement the modal edits: a new one, or an existing one by its index. */
type StatementEditTarget = { kind: 'new' } | { kind: 'existing'; index: number };

/**
 * The bucket's policy on an `iam` region: its statements as cards, an editor
 * for one statement at a time, and one save for the whole document.
 *
 * The policy is one ETag-versioned document held at the storage system, so
 * every edit lands in a local draft and "Save policy" writes it once under the
 * ETag it was read at. A save that lost to another writer is shown in place
 * with the draft intact, so the user can reload and apply their edit to what
 * is there now.
 */
export function BucketPolicyTab({ bucketName, region }: BucketPolicyTabProps) {
  const editor = useBucketPolicyEditor(bucketName, region);
  const { policy, draft } = editor;
  const roster = useQuery({ queryKey: queryKeys.members, queryFn: listMembers });
  const getMemberName = getMemberNameLookup(roster.data?.members);
  const [editTarget, setEditTarget] = useState<StatementEditTarget | null>(null);
  const [isRemoveDialogOpen, setIsRemoveDialogOpen] = useState(false);
  const isPolicyLoaded = !policy.isLoading && !policy.hasLoadFailed;

  function submitStatement(statement: PolicyStatement) {
    const index = editTarget?.kind === 'existing' ? editTarget.index : undefined;
    draft.setStatements(
      index === undefined
        ? [...draft.statements, statement]
        : draft.statements.map((current, i) => (i === index ? statement : current)),
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Heading
          tag="h2"
          size="md"
          className="gap-0.5"
          description="Access is the union of Allow statements, minus anything a Deny statement covers"
        >
          Bucket policy
        </Heading>
        {isPolicyLoaded && (
          <div className="flex items-center gap-2">
            {policy.snapshot && (
              <Button
                id="policy-remove-button"
                variant="tertiary"
                size="sm"
                disabled={draft.isStale}
                onClick={() => setIsRemoveDialogOpen(true)}
              >
                Remove policy
              </Button>
            )}
            <Button
              id="policy-add-statement"
              variant="primary"
              size="sm"
              icon={PlusIcon}
              onClick={() => setEditTarget({ kind: 'new' })}
            >
              Add statement
            </Button>
          </div>
        )}
      </div>

      {policy.isLoading && (
        <div className="flex items-center justify-center py-8">
          <Spinner ariaLabel="Loading bucket policy" size={24} />
        </div>
      )}
      {policy.hasLoadFailed && (
        <Alert
          variant="red"
          description={policy.errorMessage ?? 'Failed to load the bucket policy'}
          action={
            <Button variant="ghost" size="sm" onClick={() => void policy.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {isPolicyLoaded && (
        <LoadedPolicyView
          editor={editor}
          getMemberName={getMemberName}
          onAdd={() => setEditTarget({ kind: 'new' })}
          onEdit={(index) => setEditTarget({ kind: 'existing', index })}
        />
      )}

      <PolicyStatementModal
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        initial={editTarget?.kind === 'existing' ? draft.statements[editTarget.index] : undefined}
        onSubmit={submitStatement}
      />
      <ConfirmDialog
        open={isRemoveDialogOpen}
        onClose={() => setIsRemoveDialogOpen(false)}
        onConfirm={editor.removePolicy}
        title="Remove bucket policy"
        description="Access to this bucket will fall back to service keys. The statements in this policy cannot be recovered."
        confirmLabel="Remove policy"
      />
    </div>
  );
}

/** The policy, the draft over it, and the writes the tab makes. */
function useBucketPolicyEditor(bucketName: string, region: S3Region) {
  const { toast } = useToast();
  const policy = useBucketPolicy(bucketName, region);
  const draft = usePolicyDraft(policy.snapshot);

  async function runPolicyWrite(performWrite: () => Promise<void>, fallbackErrorMessage: string) {
    try {
      await performWrite();
    } catch (err) {
      // A conflict renders in place; anything else is a failed request.
      if (!isPolicyConflict(err)) {
        toast.error(err instanceof Error ? err.message : fallbackErrorMessage);
      }
    }
  }

  async function deleteStoredPolicy() {
    // Unreachable from the UI, which offers the removal only over a stored
    // policy; a thrown error reaches the toast rather than failing silently.
    if (!draft.etag) throw new Error('The policy has no ETag to remove it under');
    await policy.remove.mutateAsync({ etag: draft.etag });
    draft.acceptSaved(null);
    toast.success('Policy removed');
  }

  const removePolicy = () => runPolicyWrite(deleteStoredPolicy, 'Failed to remove the policy');

  const savePolicy = () =>
    runPolicyWrite(async () => {
      // A draft with no statements removes the policy: the storage system
      // stores no empty document.
      if (draft.statements.length === 0) return deleteStoredPolicy();
      const nextPolicy = { Statement: draft.statements };
      const saveResult = await policy.save.mutateAsync({ policy: nextPolicy, etag: draft.etag });
      draft.acceptSaved({ policy: nextPolicy, etag: saveResult.etag });
      toast.success('Policy saved');
    }, 'Failed to save the policy');

  // A reload that fails keeps the draft and the conflict, so nothing is lost
  // to a network error.
  async function reloadPolicy() {
    const result = await policy.refetch();
    if (result.isError) {
      toast.error('Could not reload the policy. Try again.');
      return;
    }
    policy.save.reset();
    policy.remove.reset();
    draft.reset();
  }

  return { policy, draft, savePolicy, removePolicy, reloadPolicy };
}

type BucketPolicyEditor = ReturnType<typeof useBucketPolicyEditor>;

/** The slice of the editor the loaded view reads, so a story can stub it. */
export type LoadedPolicyEditor = {
  policy: Pick<BucketPolicyEditor['policy'], 'snapshot' | 'hasConflict' | 'isWriting'>;
  draft: Pick<
    BucketPolicyEditor['draft'],
    'statements' | 'hasUnsavedEdits' | 'isStale' | 'reset' | 'setStatements'
  >;
  savePolicy: () => Promise<void>;
  reloadPolicy: () => Promise<void>;
};

/** Everything shown once the policy has loaded. */
export function LoadedPolicyView({
  editor: { policy, draft, savePolicy, reloadPolicy },
  getMemberName,
  onAdd,
  onEdit,
}: {
  editor: LoadedPolicyEditor;
  getMemberName: (userId: string) => string | undefined;
  onAdd: () => void;
  onEdit: (index: number) => void;
}) {
  const hasPolicy = Boolean(policy.snapshot);
  return (
    <>
      {(policy.hasConflict || draft.isStale) && (
        <div data-testid="policy-conflict">
          <Alert
            variant="amber"
            title="This policy changed elsewhere"
            description="Someone else saved a new version. Reload the policy, then apply your changes again."
            action={
              <Button
                id="policy-reload-button"
                variant="ghost"
                size="sm"
                onClick={() => void reloadPolicy()}
              >
                Reload policy
              </Button>
            }
          />
        </div>
      )}

      {draft.statements.length === 0 ? (
        <div
          data-testid="policy-empty"
          data-empty-state={draft.hasUnsavedEdits ? 'cleared' : 'none'}
        >
          <EmptyStateCard
            icon={ShieldCheckIcon}
            title={draft.hasUnsavedEdits ? 'This policy has no statements' : 'No policy yet'}
            description={
              draft.hasUnsavedEdits
                ? 'Saving removes the policy, and only service keys will reach this bucket.'
                : 'Without a policy, only service keys can reach this bucket. Add a statement to grant members access.'
            }
          >
            <Button
              id="policy-empty-add-statement"
              variant="primary"
              icon={PlusIcon}
              onClick={onAdd}
            >
              Add statement
            </Button>
          </EmptyStateCard>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {draft.statements.map((statement, index) => (
            <PolicyStatementCard
              key={`${statement.Sid ?? 'statement'}-${index}`}
              statement={statement}
              index={index}
              getMemberName={getMemberName}
              actions={{
                onEdit: () => onEdit(index),
                onRemove: () => draft.setStatements(draft.statements.filter((_, i) => i !== index)),
              }}
            />
          ))}
        </div>
      )}

      {draft.statements.some(isDenyForEveryone) && (
        <div data-testid="policy-denies-everyone">
          <Alert
            variant="amber"
            assertive={false}
            title="This policy denies everyone"
            description="Nobody in the organization can use this bucket while this statement is saved. Only an Owner can edit the policy to undo it."
          />
        </div>
      )}

      {draft.hasUnsavedEdits && (
        <div className="flex flex-col gap-2" data-testid="policy-save-bar">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
            <span className="text-ui text-zinc-700">Unsaved changes</span>
            <div className="flex items-center gap-2">
              <Button
                id="policy-discard-button"
                variant="ghost"
                size="sm"
                onClick={draft.reset}
                disabled={policy.isWriting}
              >
                Discard changes
              </Button>
              <Button
                id="policy-save-button"
                variant="primary"
                size="sm"
                onClick={() => void savePolicy()}
                disabled={
                  policy.isWriting || draft.isStale || (draft.statements.length === 0 && !hasPolicy)
                }
              >
                {policy.isWriting ? 'Saving...' : 'Save policy'}
              </Button>
            </div>
          </div>
          <SlowOperationIndicator isLoading={policy.isWriting} operation="Saving bucket policy" />
        </div>
      )}
    </>
  );
}
