import { useEffect, useState } from 'react';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/ssr';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole, roleNarrows } from '@filone/shared';
import type { ListMembersResponse, MemberSummary, RevokedKeySummary } from '@filone/shared';

import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { EmptyStateCard } from '../components/EmptyStateCard';
import { MembersTable } from '../components/MembersTable';
import { MembersToolbar } from '../components/MembersToolbar';
import { MemberDialogs, useMemberDialogs } from '../components/MemberDialogs';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { errorCodeOf, errorMessageOf, errorStatusOf, getMe, revokedKeysOf } from '../lib/api.js';
import {
  listMembers,
  removeMember,
  transferOwnership,
  updateMemberRole,
} from '../lib/members-api.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';
import {
  canTransferTo,
  memberName,
  ROLE_LABELS,
  useMemberActionScope,
} from '../lib/use-member-scope.js';
import {
  EMPTY_MEMBER_FILTERS,
  filterMembers,
  memberRoles,
  shouldShowMemberControls,
} from '../lib/member-table.js';
import { usePendingRows } from '../lib/use-pending-rows.js';
import type { PendingRows } from '../lib/use-pending-rows.js';

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
  pending: PendingRows;
  toastSuccess: (message: string) => void;
  toastError: (message: string) => void;
  toastInfo: (message: string) => void;
}

/**
 * Whether a removal was refused because the roster the console acted on is not
 * the one the server has.
 *
 * The row is already gone (404), or its role moved under the request and the
 * owner-count delta was decided from the old one (409). Neither is a failure to
 * report and retry: the answer is the same until the list is re-read.
 */
function isStaleRemovalTarget(error: unknown): boolean {
  const status = errorStatusOf(error);
  return status === 404 || status === 409;
}

export type RoleChange = { member: MemberSummary; role: OrgRole };

function useRoleChange(ctx: MutationContext) {
  return useMutation({
    mutationFn: ({ member, role }: RoleChange) => updateMemberRole(member.userId, role),
    onMutate: ({ member }: RoleChange) => {
      ctx.pending.add(member.userId);
    },
    onSuccess: (result, { member, role }) => {
      patchRosterRole(ctx.client, member.userId, role);
      settleAfterChange(ctx.client, member.userId, ctx.selfUserId);
      ctx.notice.clear();
      ctx.toastSuccess(
        `${memberName(member)} is now ${ROLE_LABELS[role]}${revokedSuffix(result.revokedKeys)}`,
      );
      // A key the vendor kept is still live and nothing here will try again, so
      // it is said separately rather than folded into the success line.
      if (result.failedKeys?.length) {
        ctx.toastError(
          `${namedKeys(result.failedKeys)} could not be revoked and still works. Revoke it from Access keys.`,
        );
      }
    },
    onError: (err) => {
      // The keys named here are already gone whatever the role now says, so the
      // refusal has to carry them: a message about the role alone is half the
      // answer.
      const revoked = revokedKeysOf(err);
      const remedy = `That change would leave the organization without an owner.${revokedSuffix(revoked)}`;
      if (ctx.notice.capture(err, remedy)) return;
      ctx.toastError(
        `${errorMessageOf(err, 'Failed to change that role')}${revokedSuffix(revoked)}`,
      );
    },
    onSettled: (_result, _err, { member }) => {
      ctx.pending.remove(member.userId);
    },
  });
}

/** Up to three key names, then a count, so a toast stays one line. */
function namedKeys(keys: readonly RevokedKeySummary[]): string {
  const named = keys.slice(0, 3).map((key) => key.keyName);
  const rest = keys.length - named.length;
  return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}

/** What a role change took away, appended to whatever it is being said beside. */
function revokedSuffix(keys: readonly RevokedKeySummary[] | undefined): string {
  if (!keys?.length) return '';
  return ` ${keys.length === 1 ? 'This key was' : `These ${keys.length} keys were`} revoked: ${namedKeys(keys)}.`;
}

function useMemberRemoval(ctx: MutationContext) {
  return useMutation({
    mutationFn: (member: MemberSummary) => removeMember(member.userId),
    onMutate: (member: MemberSummary) => {
      ctx.pending.add(member.userId);
    },
    onSuccess: (_result, member) => {
      dropFromRoster(ctx.client, member.userId);
      settleAfterChange(ctx.client, member.userId, ctx.selfUserId);
      ctx.notice.clear();
      ctx.toastSuccess(`${memberName(member)} was removed from the organization`);
    },
    onError: (err, member) => {
      const remedy = 'That removal would leave the organization without an owner.';
      if (ctx.notice.capture(err, remedy)) return;
      // The confirmation closes on its own, so a refusal that leaves the row in
      // place leaves it actionable and every retry earns the same answer. The
      // same shape as the invitation revoke's INVITE_NOT_FOUND branch: re-read
      // the list and state what happened rather than report a failure. A row
      // the server says is gone goes at once, so the roster is honest before
      // the refetch lands.
      if (isStaleRemovalTarget(err)) {
        if (errorStatusOf(err) === 404) dropFromRoster(ctx.client, member.userId);
        void ctx.client.invalidateQueries({ queryKey: queryKeys.members });
        ctx.toastInfo(errorMessageOf(err, 'That person is no longer on this roster.'));
        return;
      }
      ctx.toastError(errorMessageOf(err, 'Failed to remove that member'));
    },
    onSettled: (_result, _err, member) => {
      ctx.pending.remove(member.userId);
    },
  });
}

/**
 * The step-up action name, carrying who the transfer was for.
 *
 * The step-up stash holds an action string and a return path and nothing else,
 * and the target is lost across a full-page trip through Auth0. Naming the
 * member in the action is the one channel that survives it, which is why the id
 * rides along here rather than in a stash of its own.
 */
const TRANSFER_ACTION = 'transfer-ownership';

function transferStepUpAction(userId: string): string {
  return `${TRANSFER_ACTION}:${userId}`;
}

/**
 * Read the member a step-up round trip was about, and take it out of the URL so
 * a refresh does not reopen the dialog.
 */
function takeResumedTransferTarget(): string | null {
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action');
  if (action === null || !action.startsWith(`${TRANSFER_ACTION}:`)) return null;

  params.delete('action');
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
  window.history.replaceState(window.history.state, '', url);

  return action.slice(TRANSFER_ACTION.length + 1) || null;
}

function useOwnershipTransfer(ctx: MutationContext, onDone: () => void) {
  return useMutation({
    mutationFn: (member: MemberSummary) =>
      transferOwnership(member.userId, { stepUpAction: transferStepUpAction(member.userId) }),
    onSuccess: (result, member) => {
      // The org keeps exactly one Owner: the target gains the seat and the
      // caller lands as an Admin, which their own controls have to reflect
      // before they click anything else.
      patchRosterRole(ctx.client, result.userId, OrgRole.Owner);
      patchRosterRole(ctx.client, result.previousOwnerUserId, OrgRole.Admin);
      settleAfterChange(ctx.client, result.previousOwnerUserId, ctx.selfUserId);
      ctx.notice.clear();
      // The dialog goes with the seat. Left open, it offers a destructive button
      // to a caller who is now an Admin, and the server answers the second click
      // with a refusal rather than a second transfer.
      onDone();
      ctx.toastSuccess(`${memberName(member)} owns this organization now. You are an admin.`);
    },
    onError: (err) => {
      ctx.toastError(errorMessageOf(err, 'Failed to transfer ownership'));
    },
  });
}

/**
 * Who the transfer dialog is about, reopening it when a step-up sent the caller
 * through Auth0 and back.
 *
 * Reopened rather than resubmitted. The step-up is there because this is the
 * change nobody can reverse on their own, and firing it off the back of a
 * redirect the caller may have abandoned would be exactly the click-through the
 * dialog exists to prevent.
 *
 * The resume is checked against the roster it comes back to, not the one it
 * left: a trip through Auth0 takes as long as the caller takes, and the member
 * may have been promoted, removed, or become the caller's own row in the
 * meantime. A resume that no longer holds is dropped without a word — there is
 * nothing the caller asked for that could be reported as having failed.
 */
function useTransferTarget(
  members: MemberSummary[],
  rosterSettled: boolean,
  mayTransfer: boolean,
  currentUserId?: string,
) {
  const [target, setTarget] = useState<MemberSummary | null>(null);
  const [resumedUserId, setResumedUserId] = useState<string | null>(null);

  useEffect(() => {
    setResumedUserId(takeResumedTransferTarget());
  }, []);

  useEffect(() => {
    if (resumedUserId === null) return;
    const member = members.find((m) => m.userId === resumedUserId);
    if (!member) {
      // A miss before the roster arrives is the resume waiting for it, which is
      // how the ordinary case works: the first render has no members at all.
      // A miss after it has arrived is an answer.
      if (rosterSettled) setResumedUserId(null);
      return;
    }
    setResumedUserId(null);
    if (!canTransferTo(member, { mayTransfer, currentUserId })) return;
    setTarget(member);
  }, [resumedUserId, members, rosterSettled, mayTransfer, currentUserId]);

  return [target, setTarget] as const;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * The roster and everything that acts on it, without page chrome.
 *
 * A tab body rather than a page: `OrganizationPage` owns the heading and the
 * tabs, and invitations are a tab of their own beside this one rather than a
 * section under it.
 */
export function MembersRoster() {
  const { toast } = useToast();
  const client = useQueryClient();
  const scope = useMemberActionScope();
  const notice = useLastOwnerNotice();
  const pending = usePendingRows();

  const roster = useQuery({ queryKey: queryKeys.members, queryFn: listMembers });
  // The organization's name, which the transfer dialog makes the caller type.
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  const members = roster.data?.members ?? NO_MEMBERS;
  const [transferTarget, setTransferTarget] = useTransferTarget(
    members,
    roster.isSuccess,
    scope.mayTransfer,
    scope.userId,
  );

  const ctx: MutationContext = {
    client,
    selfUserId: scope.userId,
    notice,
    pending,
    toastSuccess: toast.success,
    toastError: toast.error,
    toastInfo: toast.info,
  };
  const roleChange = useRoleChange(ctx);
  const removal = useMemberRemoval(ctx);
  const closeTransfer = () => setTransferTarget(null);
  const transfer = useOwnershipTransfer(ctx, closeTransfer);

  const dialogs = useMemberDialogs(transferTarget, closeTransfer);

  // Promoting somebody to Owner is not a role change like the others: the org
  // gains a second person who can manage billing and remove anybody, the caller
  // included. It gets the confirmation removal gets. A change that takes a
  // permission away gets one too, because it revokes the access keys the new
  // role could not mint and breaks whatever client was using them — the
  // caller's own row included, which also gives up the page they would undo it
  // on. Every other move applies on the spot.
  function handleRoleChange(member: MemberSummary, role: OrgRole) {
    if (role === member.role) return;
    if (role === OrgRole.Owner) dialogs.askToPromote({ member, role });
    else if (roleNarrows(member.role, role)) dialogs.askToNarrow({ member, role });
    else roleChange.mutate({ member, role });
  }

  return (
    <>
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
          members={members}
          isPending={roster.isPending}
          isError={roster.isError}
          hasData={roster.data !== undefined}
          errorMessage={roster.error?.message}
          scope={scope}
          onChangeRole={scope.mayManage ? handleRoleChange : undefined}
          onRemove={scope.mayManage ? dialogs.askToRemove : undefined}
          onTransfer={setTransferTarget}
          pendingUserIds={pending.ids}
        />
      </div>

      <MemberDialogs
        targets={dialogs.targets}
        close={dialogs.close}
        orgName={me?.orgName ?? 'this organization'}
        selfUserId={scope.userId}
        transferring={transfer.isPending}
        onChangeRole={roleChange.mutateAsync}
        onRemove={removal.mutateAsync}
        onTransfer={transfer.mutate}
      />
    </>
  );
}

/**
 * One empty array for every render with no roster yet, so effects keyed on the
 * member list do not re-run on every render before it arrives.
 */
const NO_MEMBERS: MemberSummary[] = [];

/**
 * The roster in each of its states.
 *
 * Loading and failure live here rather than replacing the page, so the heading
 * and anything beside the table survive a failed request. A failure with rows
 * already on screen keeps them: every mutation on this page invalidates the
 * roster, so one refetch that does not come back would otherwise take away the
 * list the operator was working on, along with the change they just made.
 */
function MembersPanel({
  members,
  isPending,
  isError,
  hasData,
  errorMessage,
  scope,
  onChangeRole,
  onRemove,
  onTransfer,
  pendingUserIds,
}: {
  members: MemberSummary[];
  isPending: boolean;
  isError: boolean;
  hasData: boolean;
  errorMessage?: string;
  scope: ReturnType<typeof useMemberActionScope>;
  onChangeRole?: (member: MemberSummary, role: OrgRole) => void;
  onRemove?: (member: MemberSummary) => void;
  onTransfer?: (member: MemberSummary) => void;
  pendingUserIds: ReadonlySet<string>;
}) {
  if (isPending) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading members" size={32} />
      </div>
    );
  }

  if (isError && !hasData) {
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
      {isError && (
        <div data-testid="members-stale">
          <Alert
            variant="amber"
            title="This list may be out of date"
            description={`Refreshing failed: ${errorMessage ?? 'the request did not complete'}. The rows below are the last answer that arrived.`}
          />
        </div>
      )}
      <MembersRosterList
        members={members}
        scope={scope}
        onChangeRole={onChangeRole}
        onRemove={onRemove}
        onTransfer={onTransfer}
        pendingUserIds={pendingUserIds}
      />
    </div>
  );
}

/**
 * The roster, searchable and filterable by role once it is long enough to be
 * worth it.
 *
 * The filters live here rather than in `MembersRoster` so they are dropped when
 * the roster is: a caller who cannot read the list has nothing to narrow, and a
 * filter surviving a reload of the tab would leave rows hidden by a control that
 * is no longer on screen.
 */
function MembersRosterList({
  members,
  scope,
  onChangeRole,
  onRemove,
  onTransfer,
  pendingUserIds,
}: {
  members: MemberSummary[];
  scope: ReturnType<typeof useMemberActionScope>;
  onChangeRole?: (member: MemberSummary, role: OrgRole) => void;
  onRemove?: (member: MemberSummary) => void;
  onTransfer?: (member: MemberSummary) => void;
  pendingUserIds: ReadonlySet<string>;
}) {
  const [filters, setFilters] = useState(EMPTY_MEMBER_FILTERS);

  // Below the threshold the controls are gone, so the filters go with them: a
  // roster that shrinks past it under an active search would otherwise hide rows
  // with nothing on screen to explain why.
  const showControls = shouldShowMemberControls(members.length);
  const visible = showControls ? filterMembers(members, filters) : members;

  // One block rather than a fragment: the panel above stacks its children with
  // `gap-3`, and a fragment would put that gap between the toolbar and the table
  // on top of the toolbar's own `mb-2.5` — 22px here against the buckets table's
  // 10px, for the same pair of elements.
  return (
    <div>
      {showControls && (
        <MembersToolbar
          filters={filters}
          onChange={setFilters}
          roles={memberRoles(members)}
          matchCount={visible.length}
          totalCount={members.length}
        />
      )}

      {visible.length === 0 ? (
        <EmptyStateCard
          icon={MagnifyingGlassIcon}
          iconColor="grey"
          title="No matching members"
          description="No member matches your search and filters."
        >
          <Button
            id="members-clear-filters-button"
            variant="ghost"
            onClick={() => setFilters(EMPTY_MEMBER_FILTERS)}
          >
            Clear filters
          </Button>
        </EmptyStateCard>
      ) : (
        <MembersTable
          members={visible}
          currentUserId={scope.userId}
          mayChangeRole={scope.mayChangeRole}
          mayManageTarget={scope.mayManageTarget}
          mayTransfer={scope.mayTransfer}
          onChangeRole={onChangeRole}
          onRemove={onRemove}
          onTransfer={onTransfer}
          pendingUserIds={pendingUserIds}
        />
      )}
    </div>
  );
}
