import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from './Button';
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

function SettingRow({
  label,
  description,
  action,
}: {
  label: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <div>
        <p className="text-[13px] font-medium text-zinc-900">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      {action}
    </div>
  );
}

// eslint-disable-next-line complexity/complexity
export function MfaSettings({ me }: { me: MeResponse }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
    enrollMfaMutation.mutate();
  }

  function handleEnrollEmail() {
    enrollEmailMfaMutation.mutate();
  }

  function handleDisableMfa() {
    setConfirmDisable(false);
    disableMfaMutation.mutate();
  }

  function handleDeleteEnrollment(enrollment: MfaEnrollment) {
    setConfirmDeleteId(null);
    deleteEnrollmentMutation.mutate(enrollment);
  }

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
            <div
              key={enrollment.id}
              className="flex items-center justify-between rounded-md border border-[#e1e4ea] bg-zinc-50 px-3 py-2"
            >
              <div>
                <p className="text-[13px] font-medium text-zinc-900">
                  {formatEnrollmentType(enrollment.type)}
                </p>
                <p className="text-[11px] text-zinc-500">
                  {enrollment.name ? `${enrollment.name} — ` : ''}
                  Added {new Date(enrollment.createdAt).toLocaleDateString()}
                </p>
              </div>
              {confirmDeleteId === enrollment.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-zinc-500">Remove?</span>
                  <button
                    className="text-[11px] text-red-600 font-medium hover:text-red-700"
                    onClick={() => handleDeleteEnrollment(enrollment)}
                  >
                    Yes
                  </button>
                  <button
                    className="text-[11px] text-zinc-500 hover:text-zinc-700"
                    onClick={() => setConfirmDeleteId(null)}
                  >
                    No
                  </button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(enrollment.id)}>
                  Remove
                </Button>
              )}
            </div>
          ))}
          {confirmDisable ? (
            <div className="flex items-center gap-2 self-start">
              <span className="text-[11px] text-zinc-500">
                Remove all MFA methods? This cannot be undone.
              </span>
              <button
                className="text-[11px] text-red-600 font-medium hover:text-red-700"
                onClick={handleDisableMfa}
                disabled={disableMfaMutation.isPending}
              >
                {disableMfaMutation.isPending ? 'Removing...' : 'Confirm'}
              </button>
              <button
                className="text-[11px] text-zinc-500 hover:text-zinc-700"
                onClick={() => setConfirmDisable(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              className="text-[11px] text-red-500 hover:text-red-700 self-start"
              onClick={() => setConfirmDisable(true)}
              disabled={disableMfaMutation.isPending}
            >
              Remove all MFA methods
            </button>
          )}
        </div>
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
