import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { ApiErrorCode } from '@filone/shared';
import type {
  CreateInvitationRequest,
  CreateInvitationResponse,
  InvitationSummary,
  ListInvitationsResponse,
} from '@filone/shared';

import { Card } from '../components/Card';
import { Heading } from '../components/Heading/Heading';
import { InvitationsTable } from '../components/InvitationsTable';
import { InviteMemberForm } from '../components/InviteMemberForm';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { errorCodeOf, errorMessageOf, errorStatusOf } from '../lib/api.js';
import { createInvitation, listInvitations, revokeInvitation } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { useMemberActionScope } from '../lib/use-member-scope.js';

/**
 * Put a created invitation at the top of the list, dropping any row for the same
 * address.
 *
 * Re-inviting revokes the live invitation and writes a new one, so the answer is
 * a replacement rather than an addition — and a list that kept both would show
 * an invitation the server has already withdrawn.
 */
function upsertInvitation(client: QueryClient, invitation: InvitationSummary): void {
  client.setQueryData<ListInvitationsResponse>(queryKeys.invitations, (old) =>
    old
      ? {
          invitations: [invitation, ...old.invitations.filter((i) => i.email !== invitation.email)],
        }
      : old,
  );
}

function dropInvitation(client: QueryClient, inviteId: string): void {
  client.setQueryData<ListInvitationsResponse>(queryKeys.invitations, (old) =>
    old ? { invitations: old.invitations.filter((i) => i.inviteId !== inviteId) } : old,
  );
}

/**
 * The two refusals the invite form keeps on screen instead of toasting.
 *
 * The beta gate answers 403 with a message and deliberately no code — it says
 * the feature is not switched on for this org rather than describing what a
 * role permits, and the console renders that sentence as-is. The pending cap
 * answers `INVITE_LIMIT_REACHED`, which needs an action taken on the list right
 * beside the form. A toast for either would be gone before the operator had
 * finished reading the form it was about.
 */
function useInviteRefusals() {
  const [notEnabled, setNotEnabled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return {
    notEnabled,
    error,
    clear: () => {
      setError(null);
    },
    /** @returns whether the refusal was rendered here rather than left to a toast. */
    capture: (err: unknown): boolean => {
      const code = errorCodeOf(err);
      if (errorStatusOf(err) === 403 && code === undefined) {
        setNotEnabled(
          errorMessageOf(err, 'Inviting teammates is not enabled for this organization yet.'),
        );
        return true;
      }
      if (code === ApiErrorCode.INVITE_LIMIT_REACHED) {
        setError(errorMessageOf(err, 'This organization has too many invitations outstanding.'));
        return true;
      }
      return false;
    },
  };
}

function useCreateInvitation(
  client: QueryClient,
  refusals: ReturnType<typeof useInviteRefusals>,
  onUndelivered: (email: string | null) => void,
) {
  const { toast } = useToast();

  return useMutation({
    mutationFn: (body: CreateInvitationRequest) => createInvitation(body),
    onSuccess: (result: CreateInvitationResponse) => {
      upsertInvitation(client, result.invitation);
      void client.invalidateQueries({ queryKey: queryKeys.invitations });
      refusals.clear();
      if (result.emailSent) {
        onUndelivered(null);
        toast.success(`Invitation sent to ${result.invitation.email}`);
      } else {
        onUndelivered(result.invitation.email);
      }
    },
    onError: (err) => {
      if (refusals.capture(err)) return;
      toast.error(errorMessageOf(err, 'Failed to send that invitation'));
    },
  });
}

function useRevokeInvitation(client: QueryClient) {
  const { toast } = useToast();

  return useMutation({
    mutationFn: (invitation: InvitationSummary) => revokeInvitation(invitation.inviteId),
    onSuccess: (_result, invitation) => {
      dropInvitation(client, invitation.inviteId);
      void client.invalidateQueries({ queryKey: queryKeys.invitations });
      toast.success(`The invitation for ${invitation.email} was withdrawn`);
    },
    onError: (err) => {
      // The invitation stopped being pending under the revoke — most often
      // because it was accepted first, which makes the roster the thing that
      // changed. Both lists get re-read and the answer is stated rather than
      // reported as a failure.
      if (errorCodeOf(err) === ApiErrorCode.INVITE_NOT_FOUND) {
        void client.invalidateQueries({ queryKey: queryKeys.invitations });
        void client.invalidateQueries({ queryKey: queryKeys.members });
        toast.info(errorMessageOf(err, 'That invitation is no longer pending.'));
        return;
      }
      toast.error(errorMessageOf(err, 'Failed to withdraw that invitation'));
    },
  });
}

/**
 * Who this org is still waiting on, and how to add somebody.
 *
 * Mounted only for a caller holding `members.manage`: the list endpoint is that
 * permission rather than `members.read`, so for anybody else this whole section
 * would be a request the server refuses.
 */
export function MembersInvitations() {
  const client = useQueryClient();
  const scope = useMemberActionScope();
  const refusals = useInviteRefusals();
  const [undelivered, setUndelivered] = useState<string | null>(null);

  const pending = useQuery({ queryKey: queryKeys.invitations, queryFn: listInvitations });
  const create = useCreateInvitation(client, refusals, setUndelivered);
  const revoke = useRevokeInvitation(client);

  const invitations = pending.data?.invitations ?? [];

  return (
    <section className="flex flex-col gap-4" data-testid="invitations-section">
      <Heading
        tag="h2"
        size="lg"
        description="An invitation is the only way somebody else joins this organization."
      >
        Invitations
      </Heading>

      <Card>
        <InviteMemberForm
          roles={scope.assignableRoles}
          onSubmit={(body) => create.mutate(body)}
          submitting={create.isPending}
          notEnabledMessage={refusals.notEnabled}
          errorMessage={refusals.error}
          undeliveredEmail={undelivered}
        />
      </Card>

      <InvitationsPanel
        invitations={invitations}
        isPending={pending.isPending}
        isError={pending.isError}
        errorMessage={pending.error?.message}
        mayManageTarget={scope.mayManageTarget}
        onRevoke={(invitation) => revoke.mutate(invitation)}
        pendingInviteId={revoke.isPending ? revoke.variables?.inviteId : undefined}
      />
    </section>
  );
}

function InvitationsPanel({
  invitations,
  isPending,
  isError,
  errorMessage,
  mayManageTarget,
  onRevoke,
  pendingInviteId,
}: {
  invitations: InvitationSummary[];
  isPending: boolean;
  isError: boolean;
  errorMessage?: string;
  mayManageTarget: (targetRole: string) => boolean;
  onRevoke: (invitation: InvitationSummary) => void;
  pendingInviteId?: string;
}) {
  if (isPending) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner ariaLabel="Loading invitations" size={24} />
      </div>
    );
  }

  if (isError) {
    return (
      <div
        data-testid="invitations-error"
        className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
      >
        {errorMessage ?? 'Failed to load invitations'}
      </div>
    );
  }

  if (invitations.length === 0) {
    return (
      <p data-testid="invitations-empty" className="text-sm text-zinc-500">
        Nothing outstanding. Invitations appear here until they are accepted or withdrawn.
      </p>
    );
  }

  return (
    <InvitationsTable
      invitations={invitations}
      mayManageTarget={mayManageTarget}
      onRevoke={onRevoke}
      pendingInviteId={pendingInviteId}
    />
  );
}
