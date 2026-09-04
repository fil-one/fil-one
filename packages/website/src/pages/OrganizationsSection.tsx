import { Fragment, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowsLeftRightIcon, SignOutIcon } from '@phosphor-icons/react/dist/ssr';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { MeResponse, OrgMembershipSummary } from '@filone/shared';

import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Heading } from '../components/Heading/Heading.js';
import { OrgAvatar } from '../components/OrgAvatar';
import type { RowAction } from '../components/RowActionsMenu';
import { RowActionsMenu } from '../components/RowActionsMenu';
import { useToast } from '../components/Toast';
import { switchToOrg } from '../lib/active-org.js';
import { errorCodeOf, errorMessageOf } from '../lib/api.js';
import { removeMember } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { formatDate } from '../lib/time.js';
import { ROLE_LABELS } from '../lib/use-member-scope.js';

function RoleBadge({ role }: { role: OrgRole }) {
  return (
    <Badge color={role === OrgRole.Owner ? 'blue' : 'grey'} size="sm" weight="medium">
      {ROLE_LABELS[role] ?? role}
    </Badge>
  );
}

type OrgRowProps = {
  membership: OrgMembershipSummary;
  isActive: boolean;
  onLeave: (membership: OrgMembershipSummary) => void;
};

/**
 * One row. `Leave` only appears on the active org — `DELETE
 * /api/org/members/{userId}` acts on whatever org the session is currently
 * scoped to, not one named in the request, so leaving a different org means
 * switching into it first (which `Switch to this organization` does) and
 * coming back here.
 */
function OrgRow({ membership, isActive, onLeave }: OrgRowProps) {
  const actions: RowAction[] = [
    ...(isActive
      ? []
      : [
          {
            label: 'Switch to this organization',
            icon: ArrowsLeftRightIcon,
            onSelect: () => switchToOrg(membership.orgId),
          },
        ]),
    ...(isActive
      ? [
          {
            label: 'Leave organization',
            icon: SignOutIcon,
            destructive: true,
            onSelect: () => onLeave(membership),
          },
        ]
      : []),
  ];

  return (
    <div className="flex items-center gap-3">
      <OrgAvatar name={membership.orgName} logoUrl={membership.logoUrl} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-900">{membership.orgName}</p>
        <p className="text-xs text-zinc-500">
          {membership.joinedAt ? `Joined ${formatDate(membership.joinedAt)}` : '—'}
        </p>
      </div>
      <RoleBadge role={membership.role} />
      <RowActionsMenu aria-label={`Actions for ${membership.orgName}`} actions={actions} />
    </div>
  );
}

/**
 * Every organization the caller belongs to, with their role and when they
 * joined — the account-level view Linear's Teams settings shows, distinct
 * from the org switcher's own list (which is about switching, not about
 * seeing the full membership, and hides itself entirely for a solo account).
 */
export function OrganizationsSection({ me }: { me: MeResponse }) {
  const { toast } = useToast();
  const client = useQueryClient();
  const [leaveTarget, setLeaveTarget] = useState<OrgMembershipSummary | null>(null);

  const leave = useMutation({
    // `userId` is only absent for a caller with no membership row at all, and
    // this section never renders a row (so `onLeave` never fires) unless
    // `memberships` is non-empty, which implies one.
    mutationFn: (_membership: OrgMembershipSummary) => removeMember(me.userId!),
    onSuccess: (_result, membership) => {
      toast.success(`You left ${membership.orgName}`);
      // The active org is gone from `/me`'s own membership list; every
      // surface that reads it (the switcher, permissions, this section)
      // re-resolves from a fresh read rather than a hand-patched cache, the
      // same way the Members page's own self-removal already does.
      void client.invalidateQueries({ queryKey: queryKeys.me });
      void client.invalidateQueries({ queryKey: queryKeys.meWithMfa });
    },
    onError: (err) => {
      const remedy = 'That would leave the organization without an owner.';
      toast.error(
        errorCodeOf(err) === ApiErrorCode.LAST_OWNER
          ? errorMessageOf(err, remedy)
          : errorMessageOf(err, 'Failed to leave that organization'),
      );
    },
  });

  const memberships = me.memberships ?? [];
  if (memberships.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <Heading tag="h2" size="sm">
        Organizations
      </Heading>
      <Card padding="none">
        {/* An explicit divider between rows, not `divide-y`: that draws its
            line as a border on the following row, so `gap` (needed either
            way, to keep the edges matching `p-5`'s sides) lands unevenly
            around it instead of splitting evenly above and below. */}
        <div className="flex flex-col gap-4 p-5">
          {memberships.map((membership, index) => (
            <Fragment key={membership.orgId}>
              {index > 0 && <div className="h-px bg-zinc-200" />}
              <OrgRow
                membership={membership}
                isActive={membership.orgId === me.orgId}
                onLeave={setLeaveTarget}
              />
            </Fragment>
          ))}
        </div>
      </Card>

      <ConfirmDialog
        open={leaveTarget !== null}
        onClose={() => setLeaveTarget(null)}
        onConfirm={async () => {
          try {
            await leave.mutateAsync(leaveTarget!);
          } catch {
            // Rendered by the mutation's onError.
          }
        }}
        title="Leave this organization?"
        description={
          leaveTarget
            ? `You will lose access to ${leaveTarget.orgName} and everything in it. Anything you can rejoin only through a new invitation.`
            : ''
        }
        confirmLabel="Leave"
      />
    </div>
  );
}
