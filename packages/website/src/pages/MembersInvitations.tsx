import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { EnvelopeIcon, UserPlusIcon } from '@phosphor-icons/react/dist/ssr';
import { ApiErrorCode, MAX_PENDING_INVITATIONS_PER_ORG } from '@filone/shared';
import type {
  CreateInvitationRequest,
  CreateInvitationResponse,
  InvitationSummary,
  ListInvitationsResponse,
} from '@filone/shared';

import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { EmptyStateCard } from '../components/EmptyStateCard';
import { Heading } from '../components/Heading/Heading';
import { InvitationsTable } from '../components/InvitationsTable';
import { InviteMemberForm } from '../components/InviteMemberForm';
import { Modal, ModalHeader } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { errorCodeOf, errorMessageOf } from '../lib/api.js';
import { createInvitation, listInvitations, revokeInvitation } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { useMemberActionScope } from '../lib/use-member-scope.js';
import { usePendingRows } from '../lib/use-pending-rows.js';

/** The address as the server matches it: trimmed and case-folded. */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Put a created invitation at the top of the list, dropping any row for the same
 * address.
 *
 * Re-inviting revokes the live invitation and writes a new one, so the answer is
 * a replacement rather than an addition — and a list that kept both would show
 * an invitation the server has already withdrawn. Matched the way the server
 * supersedes, since `Bob@Example.com` and `bob@example.com` are one invitation
 * there and would otherwise be two rows here until the refetch lands.
 */
function upsertInvitation(client: QueryClient, invitation: InvitationSummary): void {
  client.setQueryData<ListInvitationsResponse>(queryKeys.invitations, (old) =>
    old
      ? {
          invitations: [
            invitation,
            ...old.invitations.filter((i) => !sameAddress(i.email, invitation.email)),
          ],
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
 * Both are matched on their own code. `INVITES_NOT_ENABLED` says the feature is
 * not switched on for this org, and the console renders that sentence in place
 * of the form. `INVITE_LIMIT_REACHED` needs an action taken on the list right
 * beside the form. A toast for either would be gone before the operator had
 * finished reading the form it was about.
 *
 * Nothing here reads the absence of a code as a refusal. An expired CSRF cookie
 * answers 403 with no code at all, and taking that for the beta gate took the
 * form off the page for a caller whose next click would have worked.
 */
function useInviteRefusals() {
  const [notEnabled, setNotEnabled] = useState<string | null>(null);
  const [capReached, setCapReached] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return {
    notEnabled,
    // Kept in the dialog rather than toasted: a toast raised while a modal is
    // open competes with it for attention and is gone in four seconds, while
    // the controls the refusal is about are still on screen.
    error,
    // A flag rather than the server's sentence: the form states the cap itself,
    // from the shared constant, and puts the remedy in the field's own error.
    capReached,
    /**
     * Drop the cap refusal. It names a slot somebody has since freed, and it is
     * cleared on the two things that free one: another attempt, and a revoke.
     * The beta state is not cleared with it — the feature is either on for this
     * org or it is not, and nothing on this page turns it on.
     */
    clear: () => {
      setCapReached(false);
      setError(null);
    },
    /** @returns whether the refusal was rendered here rather than left to a toast. */
    capture: (err: unknown): boolean => {
      const code = errorCodeOf(err);
      if (code === ApiErrorCode.INVITES_NOT_ENABLED) {
        setNotEnabled(
          errorMessageOf(err, 'Inviting teammates is not enabled for this organization yet.'),
        );
        return true;
      }
      if (code === ApiErrorCode.INVITE_LIMIT_REACHED) {
        setCapReached(true);
        return true;
      }
      // The role ceiling: the dialog is still usable at a lower role, so the
      // refusal belongs beside the picker that caused it rather than in a toast
      // behind the modal.
      if (code === ApiErrorCode.FORBIDDEN_ROLE) {
        setError(errorMessageOf(err, 'Your role cannot invite somebody at that role.'));
        return true;
      }
      return false;
    },
  };
}

/**
 * The address of an invitation that was created but never sent.
 *
 * Held here rather than read off the list, because the row carries
 * `lastSendFailed` for every stale attempt and this alert is about the one the
 * operator just made. It is cleared by the two things that answer it: a send
 * that works, and withdrawing the invitation it names.
 */
function useUndeliveredInvite() {
  // The role rides along with the address so the retry re-sends the invitation
  // that failed, rather than whatever role the form happens to be showing by
  // the time somebody presses it.
  const [invite, setInvite] = useState<CreateInvitationRequest | null>(null);

  return {
    invite,
    set: setInvite,
    /** Drop the alert when this is the address it is about. */
    clearFor: (address: string) => {
      setInvite((current) => (current && sameAddress(address, current.email) ? null : current));
    },
  };
}

function useCreateInvitation(
  client: QueryClient,
  refusals: ReturnType<typeof useInviteRefusals>,
  undelivered: ReturnType<typeof useUndeliveredInvite>,
) {
  const { toast } = useToast();

  return useMutation({
    mutationFn: (body: CreateInvitationRequest) => createInvitation(body),
    // A new attempt is the answer to the cap alert, so the alert goes as the
    // attempt starts rather than surviving beside its own remedy.
    onMutate: () => {
      refusals.clear();
    },
    onSuccess: (result: CreateInvitationResponse) => {
      upsertInvitation(client, result.invitation);
      void client.invalidateQueries({ queryKey: queryKeys.invitations });
      if (result.emailSent) {
        undelivered.set(null);
        toast.success(`Invitation sent to ${result.invitation.email}`);
      } else {
        undelivered.set({ email: result.invitation.email, role: result.invitation.role });
      }
    },
    onError: (err) => {
      if (refusals.capture(err)) return;
      toast.error(errorMessageOf(err, 'Failed to send that invitation'));
    },
  });
}

function useRevokeInvitation(
  client: QueryClient,
  refusals: ReturnType<typeof useInviteRefusals>,
  pending: ReturnType<typeof usePendingRows>,
  undelivered: ReturnType<typeof useUndeliveredInvite>,
) {
  const { toast } = useToast();

  return useMutation({
    mutationFn: (invitation: InvitationSummary) => revokeInvitation(invitation.inviteId),
    onMutate: (invitation: InvitationSummary) => {
      pending.add(invitation.inviteId);
    },
    onSuccess: (_result, invitation) => {
      dropInvitation(client, invitation.inviteId);
      void client.invalidateQueries({ queryKey: queryKeys.invitations });
      // This is the slot the cap alert was asking for.
      refusals.clear();
      // The undelivered alert asks the operator to invite the address again. It
      // has nothing to ask about once the invitation it names is withdrawn.
      undelivered.clearFor(invitation.email);
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
    onSettled: (_result, _err, invitation) => {
      pending.remove(invitation.inviteId);
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
/**
 * Opens the invite dialog when the Organization page's own Invite member button
 * asked for it.
 *
 * The request is cleared whether or not anything opened: a caller the beta gate
 * refuses is told so by the section itself, and a request left standing would
 * spring the dialog open on the next visit to this tab, which nobody asked for.
 */
function useRequestedInvite({
  inviteRequested,
  onInviteRequestHandled,
  mayIssue,
  atCap,
  openInvite,
}: {
  inviteRequested: boolean;
  onInviteRequestHandled?: () => void;
  mayIssue: boolean;
  atCap: boolean;
  openInvite: () => void;
}) {
  useEffect(() => {
    if (!inviteRequested) return;
    onInviteRequestHandled?.();
    if (mayIssue && !atCap) openInvite();
  }, [inviteRequested, onInviteRequestHandled, mayIssue, atCap, openInvite]);
}

export function MembersInvitations({
  inviteRequested = false,
  onInviteRequestHandled,
}: {
  /**
   * The Organization page's own Invite member button, asking this section to
   * open its dialog. The page cannot open it directly: only the selected tab's
   * panel is mounted, so the button selects this tab and the request is read
   * here on the way in.
   */
  inviteRequested?: boolean;
  /** Clears the request, so returning to this tab later does not reopen it. */
  onInviteRequestHandled?: () => void;
} = {}) {
  const client = useQueryClient();
  const scope = useMemberActionScope();
  const refusals = useInviteRefusals();
  const revoking = usePendingRows();
  const undelivered = useUndeliveredInvite();
  const [inviteOpen, setInviteOpen] = useState(false);

  const pending = useQuery({ queryKey: queryKeys.invitations, queryFn: listInvitations });
  const create = useCreateInvitation(client, refusals, undelivered);
  const revoke = useRevokeInvitation(client, refusals, revoking, undelivered);

  const invitations = pending.data?.invitations ?? [];
  const atCap = refusals.capReached || invitations.length >= MAX_PENDING_INVITATIONS_PER_ORG;
  /**
   * Whether this caller can send one at all. Issuing needs the beta flag as well
   * as the permission; withdrawing needs only the permission, so an org dropped
   * from the beta keeps a list it can still revoke from.
   */
  const mayIssue = scope.mayInvite && !refusals.notEnabled;
  const openInvite = () => setInviteOpen(true);

  useRequestedInvite({ inviteRequested, onInviteRequestHandled, mayIssue, atCap, openInvite });

  // Both refusals leave the dialog with nothing it could do, so it goes and the
  // page states why. Closed once here rather than derived into `open`: a derived
  // condition springs the dialog back open the moment a revoke clears the cap,
  // over a caller who never asked for it again.
  useEffect(() => {
    if (refusals.notEnabled || refusals.capReached) setInviteOpen(false);
  }, [refusals.notEnabled, refusals.capReached]);

  return (
    <section className="flex flex-col gap-4" data-testid="invitations-section">
      {/* `md` with a tight description gap, the shape every tab panel labels
          itself with: one step above body copy, so it leads its description
          without reading as a second page title under the tabs.

          No button beside it: sending an invitation is the page's own Add member
          action now, in the header above the tabs, so it is reachable from every
          tab rather than only this one. The dialog still lives here, because
          this is the list it writes to. */}
      <Heading
        tag="h2"
        size="md"
        className="gap-0.5"
        description="People who have been invited but haven't joined yet."
      >
        Invitations
      </Heading>

      {scope.mayInvite && (
        <>
          {refusals.notEnabled && (
            <div data-testid="invite-not-enabled">
              <Alert
                variant="grey"
                title="Invitations are not enabled yet"
                description={refusals.notEnabled}
              />
            </div>
          )}

          {/* The cap gates the trigger rather than the fields inside it: a dialog
            that opens only to refuse everything typed into it is worse than a
            button that says why it cannot be pressed. */}
          {atCap && (
            <div data-testid="invite-cap-reached">
              <Alert
                variant="amber"
                title={`This organization is at its limit of ${String(MAX_PENDING_INVITATIONS_PER_ORG)} pending invitations`}
                description="Revoke one below to send another."
              />
            </div>
          )}

          {/* Outlives the dialog on purpose: the send succeeded, so the dialog has
            closed, and the retry has to be reachable from the page it left
            behind. */}
          {undelivered.invite && (
            <div data-testid="invite-undelivered">
              <Alert
                variant="amber"
                title="Invitation created, but the email wasn't sent"
                // There is no link to hand over: the token lives in the email and
                // nowhere else, so the only retry is another invitation, which
                // replaces this one rather than adding a second.
                description={`The invitation to ${undelivered.invite.email} exists, but delivery failed.`}
                action={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={create.isPending}
                    onClick={() => create.mutate(undelivered.invite!)}
                  >
                    {create.isPending ? 'Sending...' : 'Send again'}
                  </Button>
                }
              />
            </div>
          )}

          <Modal
            open={inviteOpen}
            onClose={() => setInviteOpen(false)}
            size="md"
            testId="invite-dialog"
          >
            <ModalHeader
              onClose={create.isPending ? undefined : () => setInviteOpen(false)}
              description="They join as soon as they accept, at the role you choose here."
            >
              Invite a member
            </ModalHeader>
            <InviteMemberForm
              roles={scope.assignableRoles}
              onSubmit={async (body) => {
                await create.mutateAsync(body);
                setInviteOpen(false);
              }}
              submitting={create.isPending}
              errorMessage={refusals.error}
              onCancel={() => setInviteOpen(false)}
            />
          </Modal>
        </>
      )}

      <InvitationsPanel
        invitations={invitations}
        isPending={pending.isPending}
        isError={pending.isError}
        hasData={pending.data !== undefined}
        errorMessage={pending.error?.message}
        mayManageTarget={scope.mayManageTarget}
        onInvite={mayIssue ? openInvite : undefined}
        onRevoke={(invitation) => revoke.mutate(invitation)}
        onResend={(invitation) => create.mutate({ email: invitation.email, role: invitation.role })}
        pendingInviteIds={revoking.ids}
      />
    </section>
  );
}

/**
 * The invitations list in each of its states.
 *
 * A failure with rows already on screen keeps them behind a notice rather than
 * replacing them: every action on this section invalidates the list, so one
 * refetch that does not come back would take away the invitation the operator
 * just created along with the rest.
 */
function InvitationsPanel({
  invitations,
  isPending,
  isError,
  hasData,
  errorMessage,
  mayManageTarget,
  onInvite,
  onRevoke,
  onResend,
  pendingInviteIds,
}: {
  invitations: InvitationSummary[];
  isPending: boolean;
  isError: boolean;
  hasData: boolean;
  errorMessage?: string;
  mayManageTarget: (targetRole: string) => boolean;
  /** Opens the invite dialog, when this caller may send one. Absent otherwise. */
  onInvite?: () => void;
  onRevoke: (invitation: InvitationSummary) => void;
  onResend: (invitation: InvitationSummary) => void;
  pendingInviteIds: ReadonlySet<string>;
}) {
  if (isPending) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner ariaLabel="Loading invitations" size={24} />
      </div>
    );
  }

  if (isError && !hasData) {
    return (
      <div
        data-testid="invitations-error"
        className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
      >
        {errorMessage ?? 'Failed to load invitations'}
      </div>
    );
  }

  const stale = isError && (
    <div data-testid="invitations-stale">
      <Alert
        variant="amber"
        title="This list may be out of date"
        description={`Refreshing failed: ${errorMessage ?? 'the request did not complete'}. What is below is the last answer that arrived.`}
      />
    </div>
  );

  if (invitations.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {stale}
        {/* A card like every other empty list in the console, and the invitation
            goes with the button: "Invite your first member" over a card a
            ReadOnly caller cannot act on is a dead end, so that caller is told
            what the list is for instead. */}
        <div data-testid="invitations-empty">
          <EmptyStateCard
            icon={EnvelopeIcon}
            title="No pending invitations"
            description={
              onInvite
                ? 'Invite someone to this organization and they appear here until they accept.'
                : 'Invitations appear here until they are accepted or withdrawn.'
            }
          >
            {onInvite && (
              <Button
                id="invitations-empty-invite-button"
                variant="primary"
                icon={UserPlusIcon}
                onClick={onInvite}
              >
                Invite member
              </Button>
            )}
          </EmptyStateCard>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {stale}
      <InvitationsTable
        invitations={invitations}
        mayManageTarget={mayManageTarget}
        onRevoke={onRevoke}
        onResend={onResend}
        pendingInviteIds={pendingInviteIds}
      />
    </div>
  );
}
