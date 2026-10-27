import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';

import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { RecoveryCodeModal } from './RecoveryCodeModal';
import { SettingRow } from './SettingRow';
import { useToast } from './Toast';
import {
  enrollMfa,
  disableMfa,
  deleteMfaEnrollment,
  deletePasskey,
  regenerateRecoveryCode,
} from '../lib/api.js';
import {
  isSocialConnection,
  PASSKEY_PER_USER_LIMIT,
  type MeResponse,
  type MfaEnrollment,
  type PasskeyEnrollment,
} from '@filone/shared';
import { queryKeys } from '../lib/query-client.js';
import { formatDate } from '../lib/time.js';

const REGENERATE_ACTION = 'regenerate-recovery-code';

function formatEnrollmentType(type: MfaEnrollment['type']): string {
  switch (type) {
    case 'authenticator':
      return 'Authenticator app (OTP)';
    case 'webauthn-roaming':
      return 'Security key';
    case 'webauthn-platform':
      return 'Device biometrics';
    default:
      return type;
  }
}

/**
 * The enrolled two-factor methods and passkeys, as one bordered list with a
 * divider between rows rather than a filled box per row: inside the Security
 * card, a box per method read as a card within a card.
 */
function MethodList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="flex flex-col divide-y divide-zinc-200 rounded-lg border border-zinc-200">
      {children}
    </ul>
  );
}

function MethodRow({
  label,
  details,
  onRequestRemove,
  disabled,
}: {
  label: string;
  /** The parts of the second line, joined with a middle dot. */
  details: string[];
  onRequestRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-ui font-medium text-zinc-900">{label}</p>
        <p className="text-xs text-zinc-500">{details.join(' · ')}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={onRequestRemove} disabled={disabled}>
        Remove
      </Button>
    </li>
  );
}

function getAddedOn(createdAt: string | undefined): string {
  return createdAt ? `Added ${formatDate(createdAt)}` : 'Enrolled';
}

function useEnrolledMfaMutations() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const enroll = useMutation({
    mutationFn: () => enrollMfa(),
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to start MFA enrollment');
    },
  });

  const disable = useMutation({
    mutationFn: () => disableMfa(),
    onSuccess: () => {
      queryClient.setQueryData<MeResponse>(queryKeys.meWithMfa, (old) =>
        old ? { ...old, mfaEnrollments: [] } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.meWithMfa });
      toast.success('Two-factor authentication disabled');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to disable MFA');
    },
  });

  const remove = useMutation({
    mutationFn: (enrollment: MfaEnrollment) => deleteMfaEnrollment(enrollment.id),
    onSuccess: (_, enrollment) => {
      queryClient.setQueryData<MeResponse>(queryKeys.meWithMfa, (old) =>
        old
          ? { ...old, mfaEnrollments: old.mfaEnrollments.filter((e) => e.id !== enrollment.id) }
          : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.meWithMfa });
      toast.success(`Removed ${formatEnrollmentType(enrollment.type)}`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to remove enrollment');
    },
  });

  return { enroll, disable, remove };
}

function EnrolledDialogs({
  enrollmentBeingDeleted,
  closeDelete,
  onDelete,
  confirmDisable,
  closeDisable,
  onDisable,
}: {
  enrollmentBeingDeleted: MfaEnrollment | undefined;
  closeDelete: () => void;
  onDelete: () => Promise<void>;
  confirmDisable: boolean;
  closeDisable: () => void;
  onDisable: () => Promise<void>;
}) {
  const deleteTitle = enrollmentBeingDeleted
    ? `Remove ${formatEnrollmentType(enrollmentBeingDeleted.type)}`
    : 'Remove method';

  return (
    <>
      <ConfirmDialog
        open={enrollmentBeingDeleted !== undefined}
        onClose={closeDelete}
        onConfirm={onDelete}
        title={deleteTitle}
        description="This two-factor authentication method will be removed from your account."
        confirmLabel="Remove"
      />
      <ConfirmDialog
        open={confirmDisable}
        onClose={closeDisable}
        onConfirm={onDisable}
        title="Remove all methods"
        description="Two-factor authentication will be disabled and you will no longer be challenged on login. This cannot be undone."
        confirmLabel="Remove all"
      />
    </>
  );
}

function RecoveryCodeSection() {
  const { toast } = useToast();
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [recoveryCodeShown, setRecoveryCodeShown] = useState<string | null>(null);

  const regenerate = useMutation({
    mutationFn: () => regenerateRecoveryCode({ stepUpAction: REGENERATE_ACTION }),
    onSuccess: (data) => {
      setRecoveryCodeShown(data.recoveryCode);
      toast.success(data.message);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to regenerate recovery code');
    },
  });

  // Resume after a step-up redirect: the app root reads sessionStorage and
  // bounces here with ?action=regenerate-recovery-code.
  const search = useSearch({ strict: false }) as { action?: string };
  const navigate = useNavigate();
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || search.action !== REGENERATE_ACTION) return;
    resumed.current = true;
    void navigate({ to: '/settings', replace: true });
    regenerate.mutate();
  }, [search.action, navigate, regenerate]);

  return (
    <>
      <SettingRow
        label="Recovery code"
        description="Generate a single-use code for signing in if you lose access to your authenticator"
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmRegenerate(true)}
            disabled={regenerate.isPending}
          >
            {regenerate.isPending ? 'Generating...' : 'Regenerate'}
          </Button>
        }
      />
      <ConfirmDialog
        open={confirmRegenerate}
        onClose={() => setConfirmRegenerate(false)}
        onConfirm={() => regenerate.mutateAsync().then(() => undefined)}
        title="Regenerate recovery code"
        description="Your existing recovery code will be invalidated. The new code will be shown only once."
        confirmLabel="Regenerate"
      />
      <RecoveryCodeModal
        open={recoveryCodeShown !== null}
        onDone={() => setRecoveryCodeShown(null)}
        code={recoveryCodeShown ?? ''}
      />
    </>
  );
}

function EnrolledView({ me }: { me: MeResponse }) {
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const { enroll, disable, remove } = useEnrolledMfaMutations();
  const enrollmentBeingDeleted = me.mfaEnrollments.find((e) => e.id === confirmDeleteId);

  return (
    <>
      <SettingRow
        label="Two-factor authentication"
        description="Your account is protected with two-factor authentication"
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => enroll.mutate()}
            disabled={enroll.isPending}
          >
            {enroll.isPending ? 'Redirecting...' : 'Add authenticator or key'}
          </Button>
        }
      />
      <MethodList>
        {me.mfaEnrollments.map((enrollment) => (
          <MethodRow
            key={enrollment.id}
            label={formatEnrollmentType(enrollment.type)}
            details={[enrollment.name, getAddedOn(enrollment.createdAt)].filter(
              (part): part is string => Boolean(part),
            )}
            onRequestRemove={() => setConfirmDeleteId(enrollment.id)}
          />
        ))}
      </MethodList>
      {/* Removing the last method already turns two-factor off (the backend
          tears down the recovery code with it), so with one method this would
          only repeat its Remove. */}
      {me.mfaEnrollments.length > 1 && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setConfirmDisable(true)}
          disabled={disable.isPending}
        >
          Remove all methods
        </Button>
      )}
      <div className="h-px bg-zinc-200" />
      <RecoveryCodeSection />
      <EnrolledDialogs
        enrollmentBeingDeleted={enrollmentBeingDeleted}
        closeDelete={() => setConfirmDeleteId(null)}
        onDelete={async () => {
          if (!enrollmentBeingDeleted) return;
          await remove.mutateAsync(enrollmentBeingDeleted);
        }}
        confirmDisable={confirmDisable}
        closeDisable={() => setConfirmDisable(false)}
        onDisable={async () => {
          await disable.mutateAsync();
        }}
      />
    </>
  );
}

function EnableView() {
  const { toast } = useToast();

  const enrollMfaMutation = useMutation({
    mutationFn: () => enrollMfa(),
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to start MFA enrollment');
    },
  });

  return (
    <SettingRow
      label="Two-factor authentication"
      description="Use an authenticator app, security key, or device biometrics to add an extra layer of security to your account"
      action={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => enrollMfaMutation.mutate()}
          disabled={enrollMfaMutation.isPending}
        >
          {enrollMfaMutation.isPending ? 'Redirecting...' : 'Enable'}
        </Button>
      }
    />
  );
}

const DELETE_PASSKEY_ACTION = 'delete-passkey';

function mostRecentPasskey(passkeys: PasskeyEnrollment[]): PasskeyEnrollment | undefined {
  return passkeys
    .filter((p) => p.createdAt)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
}

function PasskeySettings({ passkeys }: { passkeys: PasskeyEnrollment[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => deletePasskey(id, { stepUpAction: DELETE_PASSKEY_ACTION }),
    onSuccess: (_, id) => {
      queryClient.setQueryData<MeResponse>(queryKeys.meWithMfa, (old) =>
        old ? { ...old, passkeys: (old.passkeys ?? []).filter((p) => p.id !== id) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.meWithMfa });
      toast.success('Passkey removed');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to remove passkey');
    },
  });

  const passkeyBeingDeleted = passkeys.find((p) => p.id === confirmDeleteId);
  const recent = mostRecentPasskey(passkeys);
  const count = passkeys.length;
  const description =
    count === 0
      ? "No passkeys yet. You'll be prompted to add one on your next sign-in"
      : recent?.createdAt
        ? `${count} of ${PASSKEY_PER_USER_LIMIT} enrolled, most recent added ${formatDate(recent.createdAt)}`
        : `${count} of ${PASSKEY_PER_USER_LIMIT} enrolled`;

  return (
    <>
      <SettingRow label="Passkeys" description={description} action={null} />
      {count > 0 && (
        <MethodList>
          {passkeys.map((p) => (
            <MethodRow
              key={p.id}
              label={p.name ?? 'Passkey'}
              details={[getAddedOn(p.createdAt)]}
              onRequestRemove={() => setConfirmDeleteId(p.id)}
              disabled={remove.isPending}
            />
          ))}
        </MethodList>
      )}
      <ConfirmDialog
        open={passkeyBeingDeleted !== undefined}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={async () => {
          if (!passkeyBeingDeleted) return;
          await remove.mutateAsync(passkeyBeingDeleted.id);
        }}
        title="Remove passkey"
        description="This passkey will be removed from your account. You can add a new one on your next sign-in."
        confirmLabel="Remove"
      />
    </>
  );
}

// Resume after step-up redirect: when delete-passkey returns 401 step_up_required,
// the page redirects through Universal Login. The app root reads sessionStorage
// and bounces back here with ?action=delete-passkey. The deletion itself cannot
// be replayed (id is gone from the URL), so we just clear the param.
function useClearStepUpAction(action: string) {
  const search = useSearch({ strict: false }) as { action?: string };
  const navigate = useNavigate();
  const cleared = useRef(false);
  useEffect(() => {
    if (cleared.current || search.action !== action) return;
    cleared.current = true;
    void navigate({ to: '/settings', replace: true });
  }, [search.action, navigate, action]);
}

export function MfaSettings({ me }: { me: MeResponse }) {
  useClearStepUpAction(DELETE_PASSKEY_ACTION);
  const passkeys = me.passkeys ?? [];
  const showPasskeys = me.passkeys !== undefined && !isSocialConnection(me.connectionType);
  return (
    <>
      {me.mfaEnrollments.length > 0 ? <EnrolledView me={me} /> : <EnableView />}
      {showPasskeys && (
        <>
          <div className="h-px bg-zinc-200" />
          <PasskeySettings passkeys={passkeys} />
        </>
      )}
    </>
  );
}
