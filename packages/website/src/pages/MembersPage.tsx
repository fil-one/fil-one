import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { ListMembersResponse, MemberSummary } from '@filone/shared';

import { Alert } from '../components/Alert';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MembersTable } from '../components/MembersTable';
import { TransferOwnershipDialog } from '../components/TransferOwnershipDialog';
import { PageLayout } from '../components/PageLayout.js';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { errorCodeOf, errorMessageOf, errorStatusOf, getMe } from '../lib/api.js';
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
import { usePendingRows } from '../lib/use-pending-rows.js';
import type { PendingRows } from '../lib/use-pending-rows.js';
import { MembersInvitations } from './MembersInvitations.js';

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

type RoleChange = { member: MemberSummary; role: OrgRole };

function useRoleChange(ctx: MutationContext) {
  return useMutation({
    mutationFn: ({ member, role }: RoleChange) => updateMemberRole(member.userId, role),
    onMutate: ({ member }: RoleChange) => {
      ctx.pending.add(member.userId);
    },
    onSuccess: (_result, { member, role }) => {
      patchRosterRole(ctx.client, member.userId, role);
      settleAfterChange(ctx.client, member.userId, ctx.selfUserId);
      ctx.notice.clear();
      ctx.toastSuccess(`${memberName(member)} is now ${ROLE_LABELS[role]}`);
    },
    onError: (err) => {
      const remedy = 'That change would leave the organization without an owner.';
      if (ctx.notice.capture(err, remedy)) return;
      ctx.toastError(errorMessageOf(err, 'Failed to change that role'));
    },
    onSettled: (_result, _err, { member }) => {
      ctx.pending.remove(member.userId);
    },
  });
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
// Confirmations
// ---------------------------------------------------------------------------

/** Who each confirmation is about, or null while it is closed. */
interface DialogTargets {
  promotion: RoleChange | null;
  selfChange: RoleChange | null;
  removal: MemberSummary | null;
  transfer: MemberSummary | null;
}

/**
 * Which confirmation is open and about whom.
 *
 * Three of the four live here; the transfer's target is owned above, because a
 * step-up round trip can reopen it without anybody asking again.
 */
function useMemberDialogs(transferTarget: MemberSummary | null, closeTransfer: () => void) {
  const [promotion, setPromotion] = useState<RoleChange | null>(null);
  const [selfChange, setSelfChange] = useState<RoleChange | null>(null);
  const [removal, setRemoval] = useState<MemberSummary | null>(null);

  return {
    targets: { promotion, selfChange, removal, transfer: transferTarget } as DialogTargets,
    askToPromote: setPromotion,
    askToChangeSelf: setSelfChange,
    askToRemove: setRemoval,
    close: {
      promotion: () => setPromotion(null),
      selfChange: () => setSelfChange(null),
      removal: () => setRemoval(null),
      transfer: closeTransfer,
    },
  };
}

/**
 * The target a dialog was last opened for, kept through its closing animation.
 *
 * Closing sets the target to null in the same commit that hides the dialog,
 * while the panel stays mounted for its leave transition — so copy read straight
 * off the live target becomes a sentence about nobody for the length of the
 * fade, on the dialogs whose whole job is naming who the change is about.
 */
function useClosingCopy<T>(target: T | null): T | null {
  const [last, setLast] = useState<T | null>(null);
  if (target !== null && target !== last) setLast(target);
  return target ?? last;
}

/**
 * What the caller is giving up by changing their own row.
 *
 * Every other role change is about somebody else; this one takes away the
 * caller's own authority, and below Admin it takes away the page they would undo
 * it on. So it is confirmed rather than committed on the change event, where one
 * click or one arrow key was enough.
 */
function selfChangeDescription({ member, role }: RoleChange): string {
  const from = ROLE_LABELS[member.role];
  const to = ROLE_LABELS[role];
  const opening = `You go from ${from} to ${to} in this organization.`;

  // Admin is the one step down that keeps `members.manage`, so it is the one
  // that leaves this page usable. Owner never arrives here — a move to Owner is
  // a promotion, and it has its own dialog.
  if (role === OrgRole.Admin) {
    return `${opening} Billing and the organization itself go with the owner seat, and only an owner can hand it back.`;
  }
  return `${opening} Managing members goes with it, so this is the last change you can make on this page — putting it back takes another owner or admin.`;
}

/** Every change on this page that is asked about before it is made. */
function MemberDialogs({
  targets,
  close,
  orgName,
  transferring,
  onChangeRole,
  onRemove,
  onTransfer,
}: {
  targets: DialogTargets;
  close: Record<keyof DialogTargets, () => void>;
  orgName: string;
  transferring: boolean;
  onChangeRole: (change: RoleChange) => Promise<unknown>;
  onRemove: (member: MemberSummary) => Promise<unknown>;
  onTransfer: (member: MemberSummary) => void;
}) {
  const promotion = useClosingCopy(targets.promotion);
  const selfChange = useClosingCopy(targets.selfChange);
  const removal = useClosingCopy(targets.removal);
  const transfer = useClosingCopy(targets.transfer);

  return (
    <>
      <ConfirmDialog
        open={targets.promotion !== null}
        onClose={close.promotion}
        onConfirm={() => runQuietly(targets.promotion, onChangeRole)}
        title="Make this member an owner?"
        description={
          promotion
            ? `${memberName(promotion.member)} will be able to manage billing, every member, and the organization itself — including removing you.`
            : ''
        }
        confirmLabel="Make owner"
      />

      <ConfirmDialog
        open={targets.selfChange !== null}
        onClose={close.selfChange}
        onConfirm={() => runQuietly(targets.selfChange, onChangeRole)}
        title="Change your own role?"
        description={selfChange ? selfChangeDescription(selfChange) : ''}
        confirmLabel="Change my role"
      />

      <ConfirmDialog
        open={targets.removal !== null}
        onClose={close.removal}
        onConfirm={() => runQuietly(targets.removal, onRemove)}
        title="Remove this member?"
        description={
          removal
            ? `${memberName(removal)} loses access to this organization in the console. Access keys they already created keep working until somebody revokes them.`
            : ''
        }
        confirmLabel="Remove member"
      />

      <TransferOwnershipDialog
        open={targets.transfer !== null}
        orgName={orgName}
        memberName={transfer ? memberName(transfer) : ''}
        pending={transferring}
        onClose={close.transfer}
        onConfirm={() => {
          if (targets.transfer) onTransfer(targets.transfer);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MembersPage() {
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
  // included. It gets the confirmation removal gets. Changing the caller's own
  // row gets one too, for the authority it gives up. Every other move applies on
  // the spot.
  function handleRoleChange(member: MemberSummary, role: OrgRole) {
    if (role === member.role) return;
    if (role === OrgRole.Owner) dialogs.askToPromote({ member, role });
    else if (member.userId === scope.userId) dialogs.askToChangeSelf({ member, role });
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

        {/* The invitations endpoint is `members.manage` rather than
            `members.read`, so for anybody else this section is a request the
            server refuses. It arrives a moment after the roster, which is what
            gating fail-closed on `/me` costs. */}
        {scope.mayInvite && <MembersInvitations />}
      </div>

      <MemberDialogs
        targets={dialogs.targets}
        close={dialogs.close}
        orgName={me?.orgName ?? 'this organization'}
        transferring={transfer.isPending}
        onChangeRole={roleChange.mutateAsync}
        onRemove={removal.mutateAsync}
        onTransfer={transfer.mutate}
      />
    </PageLayout>
  );
}

/**
 * One empty array for every render with no roster yet, so effects keyed on the
 * member list do not re-run on every render before it arrives.
 */
const NO_MEMBERS: MemberSummary[] = [];

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
      <p className="text-sm text-zinc-600">
        {members.length === 1 ? '1 member' : `${members.length} members`}
      </p>
      <MembersTable
        members={members}
        currentUserId={scope.userId}
        mayChangeRole={scope.mayChangeRole}
        mayManageTarget={scope.mayManageTarget}
        mayTransfer={scope.mayTransfer}
        onChangeRole={onChangeRole}
        onRemove={onRemove}
        onTransfer={onTransfer}
        pendingUserIds={pendingUserIds}
      />
    </div>
  );
}
