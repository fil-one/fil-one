import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, ShieldCheckIcon } from '@phosphor-icons/react/dist/ssr';
import type { PolicyStatement, S3Region } from '@filone/shared';

import { isPolicyConflict } from '../lib/bucket-policy-api.js';
import { listMembers } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { useBucketPolicy } from '../lib/use-bucket-policy.js';
import { usePolicyDraft } from '../lib/use-policy-draft.js';
import { Alert } from './Alert.js';
import { Button } from './Button.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { EmptyStateCard } from './EmptyStateCard.js';
import { Heading } from './Heading/Heading.js';
import { memberNamesFrom } from './PolicyPrincipalFields.js';
import { PolicyStatementCard } from './PolicyStatementCard.js';
import { PolicyStatementModal, deniesEveryone } from './PolicyStatementModal.js';
import { SlowOperationIndicator } from './SlowOperationIndicator.js';
import { Spinner } from './Spinner.js';
import { useToast } from './Toast/index.js';

export type BucketPolicyTabProps = {
  bucketName: string;
  region: S3Region;
};

/** Which statement the modal is editing: an index, or none for a new one. */
type Editing = { index?: number } | null;

/**
 * The bucket's policy on an `iam` region: its statements as cards, an editor
 * for one statement at a time, and one save for the whole document.
 *
 * The policy is one ETag-versioned document held at the storage system, so
 * every edit lands in a local draft and "Save policy" writes it once under the
 * ETag it was read at. A save that lost to another writer is shown in place
 * with the draft intact, so the admin can reload and apply their edit to what
 * is there now. Saving a draft with no statements removes the policy, since
 * the storage system stores no empty document.
 */
export function BucketPolicyTab({ bucketName, region }: BucketPolicyTabProps) {
  const editor = usePolicyEditor(bucketName, region);
  const { policy, draft } = editor;
  const roster = useQuery({ queryKey: queryKeys.members, queryFn: listMembers });
  const nameOf = memberNamesFrom(roster.data?.members);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const ready = !policy.loading && !policy.failed;

  function submitStatement(statement: PolicyStatement) {
    if (editing?.index === undefined) draft.addStatement(statement);
    else draft.updateStatement(editing.index, statement);
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Heading
          tag="h2"
          size="md"
          className="gap-0.5"
          description="Who can do what in this bucket"
        >
          Bucket policy
        </Heading>
        {ready && (
          <div className="flex items-center gap-2">
            {policy.snapshot && (
              <Button
                id="policy-remove-button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmRemove(true)}
              >
                Remove policy
              </Button>
            )}
            <Button
              id="policy-add-statement"
              variant="ghost"
              size="sm"
              icon={PlusIcon}
              onClick={() => setEditing({})}
            >
              Add statement
            </Button>
          </div>
        )}
      </div>

      {policy.loading && (
        <div className="flex items-center justify-center py-8">
          <Spinner ariaLabel="Loading bucket policy" size={24} />
        </div>
      )}
      {policy.failed && (
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
      {ready && (
        <PolicyBody
          editor={editor}
          memberName={nameOf}
          onAdd={() => setEditing({})}
          onEdit={(index) => setEditing({ index })}
        />
      )}

      <PolicyStatementModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        initial={editing?.index === undefined ? undefined : draft.statements[editing.index]}
        onSubmit={submitStatement}
      />
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={editor.removePolicy}
        title="Remove bucket policy"
        description="Access to this bucket will fall back to service keys. The statements in this policy cannot be recovered."
        confirmLabel="Remove policy"
      />
    </div>
  );
}

/** The policy, the draft over it, and the three things the tab does to them. */
function usePolicyEditor(bucketName: string, region: S3Region) {
  const { toast } = useToast();
  const policy = useBucketPolicy(bucketName, region);
  const draft = usePolicyDraft(policy.snapshot);
  const etag = policy.snapshot?.etag;

  async function removePolicy() {
    if (!etag) return;
    await policy.remove.mutateAsync({ etag });
    draft.acceptSaved(null);
    toast.success('Policy removed');
  }

  // The draft's ETag rather than the query's: the user edited the document
  // they read, and a newer one the query has since fetched is exactly the
  // write the compare-and-set exists to refuse.
  async function save() {
    try {
      // A draft with no statements removes the policy: the storage system
      // stores no empty document.
      if (draft.statements.length === 0) {
        if (!draft.etag) return;
        await policy.remove.mutateAsync({ etag: draft.etag });
        draft.acceptSaved(null);
        toast.success('Policy removed');
        return;
      }
      const document = { statement: draft.statements };
      const written = await policy.save.mutateAsync({ policy: document, etag: draft.etag });
      draft.acceptSaved({ policy: document, etag: written.etag });
      toast.success('Policy saved');
    } catch (err) {
      // A conflict renders in place; anything else is a failed request.
      if (!isPolicyConflict(err)) {
        toast.error(err instanceof Error ? err.message : 'Failed to save the policy');
      }
    }
  }

  async function reload() {
    await policy.refetch();
    policy.save.reset();
    policy.remove.reset();
    draft.reset();
  }

  return { policy, draft, save, removePolicy, reload };
}

type Editor = ReturnType<typeof usePolicyEditor>;

/** The loaded tab: the conflict alert, the statements or the empty state, the warnings, the save bar. */
function PolicyBody({
  editor: { policy, draft, save, reload },
  memberName,
  onAdd,
  onEdit,
}: {
  editor: Editor;
  memberName: (userId: string) => string | undefined;
  onAdd: () => void;
  onEdit: (index: number) => void;
}) {
  const hasPolicy = Boolean(policy.snapshot);
  return (
    <>
      {(policy.conflict || draft.stale) && (
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
                onClick={() => void reload()}
              >
                Reload policy
              </Button>
            }
          />
        </div>
      )}

      {draft.statements.length === 0 ? (
        <div data-testid="policy-empty" data-empty-state={draft.dirty ? 'cleared' : 'none'}>
          <EmptyStateCard
            icon={ShieldCheckIcon}
            title={draft.dirty ? 'This policy has no statements' : 'No policy yet'}
            description={
              draft.dirty
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
              key={`${statement.sid ?? 'statement'}-${index}`}
              statement={statement}
              index={index}
              memberName={memberName}
              onEdit={() => onEdit(index)}
              onRemove={() => draft.removeStatement(index)}
            />
          ))}
        </div>
      )}

      {draft.statements.some(deniesEveryone) && (
        <div data-testid="policy-denies-everyone">
          <Alert
            variant="amber"
            assertive={false}
            title="This policy denies everyone"
            description="Nobody in the organization can use this bucket while this statement is saved. Only an Owner can edit the policy to undo it."
          />
        </div>
      )}

      {draft.dirty && (
        <div className="flex flex-col gap-2" data-testid="policy-save-bar">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
            <span className="text-ui text-zinc-700">Unsaved changes</span>
            <div className="flex items-center gap-2">
              <Button
                id="policy-discard-button"
                variant="ghost"
                size="sm"
                onClick={draft.reset}
                disabled={policy.saving}
              >
                Discard changes
              </Button>
              <Button
                id="policy-save-button"
                variant="primary"
                size="sm"
                onClick={() => void save()}
                disabled={
                  policy.saving || draft.stale || (draft.statements.length === 0 && !hasPolicy)
                }
              >
                {policy.saving ? 'Saving...' : 'Save policy'}
              </Button>
            </div>
          </div>
          <SlowOperationIndicator isLoading={policy.saving} operation="Saving bucket policy" />
        </div>
      )}
    </>
  );
}
