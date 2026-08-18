import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { ListMembersResponse, MemberSummary } from '@filone/shared';

import { Alert } from '../components/Alert';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MembersTable } from '../components/MembersTable';
import { PageLayout } from '../components/PageLayout.js';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { errorCodeOf, errorMessageOf } from '../lib/api.js';
import { listMembers, removeMember, updateMemberRole } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { ROLE_LABELS, useMemberActionScope } from '../lib/use-member-scope.js';

/**
 * How a member is named in a dialog and a toast. The same fallback the table
 * uses, so the row and the sentence about it agree.
 */
function nameOf(member: MemberSummary): string {
  return member.name || member.email || member.userId;
}

// ---------------------------------------------------------------------------
// Cache edits
// ---------------------------------------------------------------------------

function patchRosterRole(client: QueryClient, userId: string, role: OrgRole): void {
  client.setQueryData<ListMembersResponse>(queryKeys.members, (old) =>
    old ? { members: old.members.map((m) => (m.userId === userId ? { ...m, role } : m)) } : old,
  );
}

function dropFromRoster(client: QueryClient, userId: string): void {
  client.setQueryData<ListMembersResponse>(queryKeys.members, (old) =>
    old ? { members: old.members.filter((m) => m.userId !== userId) } : old,
  );
}

/**
 * What a membership change invalidates besides the roster.
 *
 * A demotion revokes that member's pending invitations the new role could not
 * have issued, so the list beside this one may have shrunk. And a caller who
 * changed their own row keeps the permissions of the role they left until `/me`
 * is read again — a console offering buttons the server will now refuse.
 */
function settleAfterChange(client: QueryClient, userId: string, selfUserId?: string): void {
  void client.invalidateQueries({ queryKey: queryKeys.members });
  void client.invalidateQueries({ queryKey: queryKeys.invitations });
  if (userId === selfUserId) void client.invalidateQueries({ queryKey: queryKeys.me });
}

// ---------------------------------------------------------------------------
// The refusal that outlives a toast
// ---------------------------------------------------------------------------

interface LastOwnerNotice {
  message: string | null;
  clear: () => void;
  /** @returns whether the error was the last-owner refusal. */
  capture: (err: unknown, fallback: string) => boolean;
}

/**
 * `LAST_OWNER` is refused with a remedy — promote somebody, or transfer the seat
 * — and a toast takes that remedy away after four seconds, while the operator is
 * still looking at the row they tried to change. It stays on the page until the
 * next attempt clears it.
 */
function useLastOwnerNotice(): LastOwnerNotice {
  const [message, setMessage] = useState<string | null>(null);

  return {
    message,
    clear: () => setMessage(null),
    capture: (err, fallback) => {
      if (errorCodeOf(err) !== ApiErrorCode.LAST_OWNER) return false;
      setMessage(errorMessageOf(err, fallback));
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

interface MutationContext {
  client: QueryClient;
  selfUserId?: string;
  notice: LastOwnerNotice;
  toastSuccess: (message: string) => void;
  toastError: (message: string) => void;
}

type RoleChange = { member: MemberSummary; role: OrgRole };

function useRoleChange(ctx: MutationContext) {
  return useMutation({
    mutationFn: ({ member, role }: RoleChange) => updateMemberRole(member.userId, role),
    onSuccess: (_result, { member, role }) => {
      patchRosterRole(ctx.client, member.userId, role);
      settleAfterChange(ctx.client, member.userId, ctx.selfUserId);
      ctx.notice.clear();
      ctx.toastSuccess(`${nameOf(member)} is now ${ROLE_LABELS[role]}`);
    },
    onError: (err) => {
      const remedy = 'That change would leave the organization without an owner.';
      if (ctx.notice.capture(err, remedy)) return;
      ctx.toastError(errorMessageOf(err, 'Failed to change that role'));
    },
  });
}

function useMemberRemoval(ctx: MutationContext) {
  return useMutation({
    mutationFn: (member: MemberSummary) => removeMember(member.userId),
    onSuccess: (_result, member) => {
      dropFromRoster(ctx.client, member.userId);
      settleAfterChange(ctx.client, member.userId, ctx.selfUserId);
      ctx.notice.clear();
      ctx.toastSuccess(`${nameOf(member)} was removed from the organization`);
    },
    onError: (err) => {
      const remedy = 'That removal would leave the organization without an owner.';
      if (ctx.notice.capture(err, remedy)) return;
      ctx.toastError(errorMessageOf(err, 'Failed to remove that member'));
    },
  });
}

/** The member a mutation is in flight for — that row's controls go inert. */
function inFlightUserId(
  roleChange: ReturnType<typeof useRoleChange>,
  removal: ReturnType<typeof useMemberRemoval>,
): string | undefined {
  if (roleChange.isPending) return roleChange.variables?.member.userId;
  if (removal.isPending) return removal.variables?.userId;
  return undefined;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MembersPage() {
  const { toast } = useToast();
  const client = useQueryClient();
  const scope = useMemberActionScope();
  const notice = useLastOwnerNotice();

  const roster = useQuery({ queryKey: queryKeys.members, queryFn: listMembers });

  const ctx: MutationContext = {
    client,
    selfUserId: scope.userId,
    notice,
    toastSuccess: toast.success,
    toastError: toast.error,
  };
  const roleChange = useRoleChange(ctx);
  const removal = useMemberRemoval(ctx);

  // Promoting somebody to Owner is not a role change like the others: the org
  // gains a second person who can manage billing and remove anybody, the caller
  // included. It gets the confirmation removal gets. Every other move applies on
  // the spot.
  const [promotion, setPromotion] = useState<RoleChange | null>(null);
  const [removalTarget, setRemovalTarget] = useState<MemberSummary | null>(null);

  function handleRoleChange(member: MemberSummary, role: OrgRole) {
    if (role === member.role) return;
    if (role === OrgRole.Owner) setPromotion({ member, role });
    else roleChange.mutate({ member, role });
  }

  return (
    <PageLayout
      title="Members"
      headingId="members-heading"
      description="Who is in this organization, and what each of them can do"
    >
      <div className="flex flex-col gap-6">
        {notice.message && (
          <div data-testid="members-last-owner">
            <Alert
              variant="amber"
              title="An organization keeps at least one owner"
              description={notice.message}
            />
          </div>
        )}

        <MembersPanel
          members={roster.data?.members ?? []}
          isPending={roster.isPending}
          isError={roster.isError}
          errorMessage={roster.error?.message}
          scope={scope}
          onChangeRole={scope.mayManage ? handleRoleChange : undefined}
          onRemove={scope.mayManage ? setRemovalTarget : undefined}
          pendingUserId={inFlightUserId(roleChange, removal)}
        />
      </div>

      <ConfirmDialog
        open={promotion !== null}
        onClose={() => setPromotion(null)}
        onConfirm={() => runQuietly(promotion, roleChange.mutateAsync)}
        title="Make this member an owner?"
        description={
          promotion
            ? `${nameOf(promotion.member)} will be able to manage billing, every member, and the organization itself — including removing you.`
            : ''
        }
        confirmLabel="Make owner"
      />

      <ConfirmDialog
        open={removalTarget !== null}
        onClose={() => setRemovalTarget(null)}
        onConfirm={() => runQuietly(removalTarget, removal.mutateAsync)}
        title="Remove this member?"
        description={
          removalTarget
            ? `${nameOf(removalTarget)} loses access to this organization in the console. Access keys they already created keep working until somebody revokes them.`
            : ''
        }
        confirmLabel="Remove member"
      />
    </PageLayout>
  );
}

/**
 * Run a confirmed mutation against the dialog's target and swallow its
 * rejection.
 *
 * `ConfirmDialog` awaits what it is given, and a rejection there would escape as
 * an unhandled promise while the mutation's own `onError` has already rendered
 * the answer — inline for the last-owner refusal, a toast for everything else.
 * A null target is the dialog closing as the confirm lands, which is nothing to
 * run.
 */
async function runQuietly<T>(target: T | null, run: (target: T) => Promise<unknown>) {
  if (target === null) return;
  try {
    await run(target);
  } catch {
    // Rendered by the mutation's onError.
  }
}

/**
 * The roster in each of its states.
 *
 * Loading and failure live here rather than replacing the page, so the heading
 * and anything beside the table survive a failed request.
 */
function MembersPanel({
  members,
  isPending,
  isError,
  errorMessage,
  scope,
  onChangeRole,
  onRemove,
  pendingUserId,
}: {
  members: MemberSummary[];
  isPending: boolean;
  isError: boolean;
  errorMessage?: string;
  scope: ReturnType<typeof useMemberActionScope>;
  onChangeRole?: (member: MemberSummary, role: OrgRole) => void;
  onRemove?: (member: MemberSummary) => void;
  pendingUserId?: string;
}) {
  if (isPending) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading members" size={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <div
        data-testid="members-error"
        className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
      >
        {errorMessage ?? 'Failed to load members'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-zinc-600">
        {members.length === 1 ? '1 member' : `${members.length} members`}
      </p>
      <MembersTable
        members={members}
        currentUserId={scope.userId}
        mayChangeRole={scope.mayChangeRole}
        mayManageTarget={scope.mayManageTarget}
        onChangeRole={onChangeRole}
        onRemove={onRemove}
        pendingUserId={pendingUserId}
      />
    </div>
  );
}
