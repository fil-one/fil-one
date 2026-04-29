import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { SettingRow } from './SettingRow';
import { useToast } from './Toast';
import { enrollMfa, enrollEmailMfa, disableMfa, deleteMfaEnrollment } from '../lib/api.js';
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
    case 'email':
      return 'Email';
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
          Added {new Date(enrollment.createdAt).toLocaleDateString()}
        </p>
      </div>
      <Button variant="ghost" size="sm" onClick={onRequestRemove}>
        Remove
      </Button>
    </div>
  );
}

// eslint-disable-next-line complexity/complexity
export function MfaSettings({ me }: { me: MeResponse }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmReplaceEmail, setConfirmReplaceEmail] = useState(false);

  const onlyEmailEnrolled =
    me.mfaEnrollments.length > 0 && me.mfaEnrollments.every((e) => e.type === 'email');

  const enrollMfaMutation = useMutation({
    mutationFn: () => enrollMfa(),
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to start MFA enrollment');
    },
  });

  const enrollEmailMfaMutation = useMutation({
    mutationFn: () => enrollEmailMfa(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.meWithMfa });
      toast.success('Email two-factor authentication enabled');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to enable email MFA');
    },
  });

  const disableMfaMutation = useMutation({
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

  const deleteEnrollmentMutation = useMutation({
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

  function handleEnrollMfa() {
    if (onlyEmailEnrolled) {
      setConfirmReplaceEmail(true);
      return;
    }
    enrollMfaMutation.mutate();
  }

  async function handleConfirmReplaceEmail() {
    await enrollMfaMutation.mutateAsync();
  }

  function handleEnrollEmail() {
    enrollEmailMfaMutation.mutate();
  }

  async function handleDisableMfa() {
    await disableMfaMutation.mutateAsync();
  }

  async function handleDeleteEnrollment() {
    const enrollment = me.mfaEnrollments.find((e) => e.id === confirmDeleteId);
    if (!enrollment) return;
    await deleteEnrollmentMutation.mutateAsync(enrollment);
  }

  const enrollmentBeingDeleted = me.mfaEnrollments.find((e) => e.id === confirmDeleteId);

  if (me.mfaEnrollments.length > 0) {
    return (
      <>
        <SettingRow
          label="Two-factor authentication"
          description="Your account is protected with two-factor authentication"
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={handleEnrollMfa}
              disabled={enrollMfaMutation.isPending}
            >
              {enrollMfaMutation.isPending ? 'Redirecting...' : 'Add authenticator or key'}
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
            disabled={disableMfaMutation.isPending}
          >
            Remove all MFA methods
          </button>
        </div>
        <ConfirmDialog
          open={confirmReplaceEmail}
          onClose={() => setConfirmReplaceEmail(false)}
          onConfirm={handleConfirmReplaceEmail}
          title="Replace email two-factor authentication"
          description="Enabling an authenticator or security key will replace your email two-factor authentication."
          confirmLabel="Replace email MFA"
        />
        <ConfirmDialog
          open={enrollmentBeingDeleted !== undefined}
          onClose={() => setConfirmDeleteId(null)}
          onConfirm={handleDeleteEnrollment}
          title={
            enrollmentBeingDeleted
              ? `Remove ${formatEnrollmentType(enrollmentBeingDeleted.type)}`
              : 'Remove method'
          }
          description="This two-factor authentication method will be removed from your account."
          confirmLabel="Remove"
        />
        <ConfirmDialog
          open={confirmDisable}
          onClose={() => setConfirmDisable(false)}
          onConfirm={handleDisableMfa}
          title="Remove all MFA methods"
          description="Two-factor authentication will be disabled and you will no longer be challenged on login. This cannot be undone."
          confirmLabel="Remove all"
        />
      </>
    );
  }

  return (
    <>
      <SettingRow
        label="Two-factor authentication"
        description="Add an extra layer of security to your account"
        action={<span />}
      />
      <div className="flex flex-col gap-2 ml-0.5">
        <button
          className="flex items-center justify-between rounded-md border border-[#e1e4ea] bg-zinc-50 px-3 py-2.5 hover:bg-zinc-100 transition-colors text-left w-full"
          onClick={handleEnrollEmail}
          disabled={enrollEmailMfaMutation.isPending}
        >
          <div>
            <p className="text-[13px] font-medium text-zinc-900">
              {enrollEmailMfaMutation.isPending ? 'Enabling...' : 'Enable with email'}
            </p>
            <p className="text-[11px] text-zinc-500">
              Receive a 6-digit code at your verified email address
            </p>
          </div>
        </button>
        <button
          className="flex items-center justify-between rounded-md border border-[#e1e4ea] bg-zinc-50 px-3 py-2.5 hover:bg-zinc-100 transition-colors text-left w-full"
          onClick={handleEnrollMfa}
          disabled={enrollMfaMutation.isPending}
        >
          <div>
            <p className="text-[13px] font-medium text-zinc-900">
              {enrollMfaMutation.isPending
                ? 'Redirecting...'
                : 'Enable with authenticator app or security key'}
            </p>
            <p className="text-[11px] text-zinc-500">
              Use an app like Google Authenticator, or a hardware security key
            </p>
          </div>
        </button>
      </div>
    </>
  );
}
