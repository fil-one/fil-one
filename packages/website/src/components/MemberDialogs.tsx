import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { MemberSummary } from '@filone/shared';

import { ConfirmDialog } from './ConfirmDialog';
import { RoleNarrowingDialog } from './RoleNarrowingDialog';
import { TransferOwnershipDialog } from './TransferOwnershipDialog';
import { getRoleChangePreview } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { memberName, ROLE_LABELS } from '../lib/use-member-scope.js';
import type { RoleChange } from '../pages/MembersPage.js';

/**
 * Every change on the members roster that is asked about before it is made.
 *
 * Its own module because the roster page is otherwise the mutations and the
 * table, and because two of these dialogs read from the server: the narrowing
 * preview here, and the step-up round trip the transfer dialog comes back from.
 */

/** Who each confirmation is about, or null while it is closed. */
export interface DialogTargets {
  promotion: RoleChange | null;
  /** A change that takes a permission away, whether the caller's own or not. */
  narrowing: RoleChange | null;
  removal: MemberSummary | null;
  transfer: MemberSummary | null;
}

/**
 * Which confirmation is open and about whom.
 *
 * Three of the four live here; the transfer's target is owned above, because a
 * step-up round trip can reopen it without anybody asking again.
 */
export function useMemberDialogs(transferTarget: MemberSummary | null, closeTransfer: () => void) {
  const [promotion, setPromotion] = useState<RoleChange | null>(null);
  const [narrowing, setNarrowing] = useState<RoleChange | null>(null);
  const [removal, setRemoval] = useState<MemberSummary | null>(null);

  return {
    targets: { promotion, narrowing, removal, transfer: transferTarget } as DialogTargets,
    askToPromote: setPromotion,
    askToNarrow: setNarrowing,
    askToRemove: setRemoval,
    close: {
      promotion: () => setPromotion(null),
      narrowing: () => setNarrowing(null),
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

/**
 * The narrowing dialog, and the preview it reads.
 *
 * The query is keyed on the target and the role being asked about, and only
 * runs while the dialog is open: it names another member's access keys, and
 * asking about a role nobody holds yet is a question that goes stale the moment
 * the change lands.
 */
function RoleNarrowingPrompt({
  target,
  self,
  onClose,
  onConfirm,
}: {
  target: RoleChange | null;
  self: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  // Kept through the closing transition, so the copy does not blank mid-fade.
  const change = useClosingCopy(target);
  const preview = useQuery({
    queryKey: change
      ? queryKeys.roleChangePreview(change.member.userId, change.role)
      : queryKeys.roleChangePreview('', OrgRole.Member),
    queryFn: () => getRoleChangePreview(change!.member.userId, change!.role),
    enabled: target !== null && change !== null,
  });

  if (!change) return null;

  return (
    <RoleNarrowingDialog
      open={target !== null}
      memberName={memberName(change.member)}
      self={self}
      fromRole={ROLE_LABELS[change.member.role]}
      toRole={ROLE_LABELS[change.role]}
      note={self ? selfChangeDescription(change) : undefined}
      keys={preview.data?.keys}
      survivingCount={preview.data?.survivingCount ?? 0}
      unattributedCount={preview.data?.unattributedCount ?? 0}
      loading={preview.isPending}
      error={preview.isError}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

/** Every change on this page that is asked about before it is made. */
export function MemberDialogs({
  targets,
  close,
  orgName,
  selfUserId,
  transferring,
  onChangeRole,
  onRemove,
  onTransfer,
}: {
  targets: DialogTargets;
  close: Record<keyof DialogTargets, () => void>;
  orgName: string;
  /** The caller's own row, which the narrowing copy addresses directly. */
  selfUserId: string | undefined;
  transferring: boolean;
  onChangeRole: (change: RoleChange) => Promise<unknown>;
  onRemove: (member: MemberSummary) => Promise<unknown>;
  onTransfer: (member: MemberSummary) => void;
}) {
  const promotion = useClosingCopy(targets.promotion);
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

      <RoleNarrowingPrompt
        target={targets.narrowing}
        self={targets.narrowing?.member.userId === selfUserId}
        onClose={close.narrowing}
        onConfirm={() => runQuietly(targets.narrowing, onChangeRole)}
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
