import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { SettingRow } from './SettingRow';
import { useToast } from './Toast';
import { enrollMfa, disableMfa, deleteMfaEnrollment } from '../lib/api.js';
import type { MeResponse, MfaEnrollment } from '@filone/shared';
import { queryKeys } from '../lib/query-client.js';

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

function EnrollmentRow({
  enrollment,
  onRequestRemove,
}: {
  enrollment: MfaEnrollment;
  onRequestRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-[#e1e4ea] bg-zinc-50 px-3 py-2">
      <div>
        <p className="text-[13px] font-medium text-zinc-900">
          {formatEnrollmentType(enrollment.type)}
        </p>
        <p className="text-[11px] text-zinc-500">
          {enrollment.name ? `${enrollment.name} — ` : ''}
          {enrollment.createdAt
            ? `Added ${new Date(enrollment.createdAt).toLocaleDateString()}`
            : 'Enrolled'}
        </p>
      </div>
      <Button variant="ghost" size="sm" onClick={onRequestRemove}>
        Remove
      </Button>
    </div>
  );
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
        title="Remove all MFA methods"
        description="Two-factor authentication will be disabled and you will no longer be challenged on login. This cannot be undone."
        confirmLabel="Remove all"
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
      <div className="flex flex-col gap-2 ml-0.5">
        {me.mfaEnrollments.map((enrollment) => (
          <EnrollmentRow
            key={enrollment.id}
            enrollment={enrollment}
            onRequestRemove={() => setConfirmDeleteId(enrollment.id)}
          />
        ))}
        <button
          className="text-[11px] text-red-500 hover:text-red-700 self-start"
          onClick={() => setConfirmDisable(true)}
          disabled={disable.isPending}
        >
          Remove all MFA methods
        </button>
      </div>
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

export function MfaSettings({ me }: { me: MeResponse }) {
  if (me.mfaEnrollments.length > 0) {
    return <EnrolledView me={me} />;
  }
  return <EnableView />;
}
