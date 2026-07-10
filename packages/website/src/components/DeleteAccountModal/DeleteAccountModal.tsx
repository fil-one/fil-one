import { useEffect, useState } from 'react';
import { DialogTitle } from '@headlessui/react';
import { useMutation } from '@tanstack/react-query';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr';
import { ApiErrorCode, DELETION_CODE_LENGTH } from '@filone/shared';
import { deleteAccount, requestDeletionChallenge } from '../../lib/api.js';
import { queryClient } from '../../lib/query-client.js';
import { Button } from '../Button';
import { FormField } from '../FormField';
import { IconBox } from '../IconBox';
import { Input } from '../Input';
import { Modal, ModalBody, ModalFooter } from '../Modal';
import { Spinner } from '../Spinner';

export type DeleteAccountModalProps = {
  open: boolean;
  onClose: () => void;
  orgName: string;
};

type Step = 'confirm' | 'code';

function deleteErrorMessage(err: unknown): string {
  const status = (err as { status?: number }).status;
  const code = (err as { code?: string }).code;
  if (status === 410 || code === ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED) {
    return 'That code has expired or been locked. Request a new one.';
  }
  return err instanceof Error ? err.message : 'Failed to delete the account';
}

/** Seconds until `resendAvailableAt`, ticking every second. */
function useResendCountdown(resendAvailableAt: string | null): number {
  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (!resendAvailableAt) return;
    const tick = () => {
      const left = Math.ceil((new Date(resendAvailableAt).getTime() - Date.now()) / 1000);
      setSecondsLeft(Math.max(0, left));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [resendAvailableAt]);
  return secondsLeft;
}

function useDeleteAccountFlow(orgName: string, typedName: string, code: string) {
  const [step, setStep] = useState<Step>('confirm');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState<string | null>(null);
  const resendSecondsLeft = useResendCountdown(resendAvailableAt);

  const challengeMutation = useMutation({
    mutationFn: requestDeletionChallenge,
    onSuccess: (challenge) => {
      setResendAvailableAt(challenge.resendAvailableAt);
      setCodeError(null);
      setStep('code');
    },
    onError: (err) => {
      setCodeError(err instanceof Error ? err.message : 'Failed to send the verification code');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteAccount({ code, orgName: typedName.trim() }),
    onSuccess: () => {
      // Cookies are already cleared by the response; discard all client state
      // and hard-navigate so nothing refetches against the dead session.
      queryClient.clear();
      window.location.assign('/account-deleted');
    },
    onError: (err) => setCodeError(deleteErrorMessage(err)),
  });

  return {
    step,
    setStep,
    codeError,
    setCodeError,
    resendSecondsLeft,
    challengeMutation,
    deleteMutation,
    busy: challengeMutation.isPending || deleteMutation.isPending,
    nameMatches: typedName.trim() === orgName,
    codeComplete: new RegExp(`^\\d{${DELETION_CODE_LENGTH}}$`).test(code),
  };
}

type Flow = ReturnType<typeof useDeleteAccountFlow>;

/**
 * Two-step irreversible account deletion (FIL-112): type the exact org name
 * to unlock sending a verification code, then enter the emailed 6-digit code
 * to execute. On success the SPA state is discarded and the browser is sent
 * to the static /account-deleted page — deletion reads as instantly complete
 * while the backend teardown finishes asynchronously.
 */
export function DeleteAccountModal({ open, onClose, orgName }: DeleteAccountModalProps) {
  const [typedName, setTypedName] = useState('');
  const [code, setCode] = useState('');
  const flow = useDeleteAccountFlow(orgName, typedName, code);

  function handleClose() {
    if (flow.busy) return;
    flow.setStep('confirm');
    setTypedName('');
    setCode('');
    flow.setCodeError(null);
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} size="sm" testId="delete-account-modal">
      <ModalBody>
        <DeletionWarning orgName={orgName} />
        <div className="mt-4 flex flex-col gap-3 px-2">
          {flow.step === 'confirm' ? (
            <ConfirmStep orgName={orgName} typedName={typedName} onChange={setTypedName} />
          ) : (
            <CodeStep code={code} flow={flow} onChange={setCode} />
          )}
          {flow.codeError && <p className="text-xs text-red-600">{flow.codeError}</p>}
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex w-full gap-3">
          <Button
            id="delete-account-cancel-button"
            variant="ghost"
            className="flex-1"
            onClick={handleClose}
            disabled={flow.busy}
          >
            Cancel
          </Button>
          <PrimaryAction flow={flow} />
        </div>
      </ModalFooter>
    </Modal>
  );
}

function DeletionWarning({ orgName }: { orgName: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-2 pt-6 pb-0 text-center">
      <IconBox icon={WarningCircleIcon} color="red" size="lg" />
      <div className="flex flex-col gap-1">
        <DialogTitle as="p" className="text-base font-medium text-zinc-900">
          Delete account
        </DialogTitle>
        <p className="text-sm text-zinc-500">
          This permanently deletes your Fil One account and organization{' '}
          <span className="font-medium text-zinc-900">{orgName}</span>: your subscription is
          canceled immediately, all access keys are revoked, and your profile and account data are
          deleted. Object data stored with our storage provider is immediately locked and
          inaccessible, and is scheduled for later destruction — it is not instantly erased from
          underlying storage. This cannot be undone.
        </p>
      </div>
    </div>
  );
}

function ConfirmStep({
  orgName,
  typedName,
  onChange,
}: {
  orgName: string;
  typedName: string;
  onChange: (value: string) => void;
}) {
  return (
    <FormField label={`Type "${orgName}" to continue`} htmlFor="delete-account-org-name">
      <Input
        id="delete-account-org-name"
        value={typedName}
        onChange={onChange}
        placeholder={orgName}
        autoComplete="off"
      />
    </FormField>
  );
}

function CodeStep({
  code,
  flow,
  onChange,
}: {
  code: string;
  flow: Flow;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <FormField
        label="Enter the 6-digit code we emailed you"
        htmlFor="delete-account-code"
        description="The code expires in 15 minutes."
      >
        <Input
          id="delete-account-code"
          value={code}
          onChange={(value) => {
            onChange(value.replace(/\D/g, '').slice(0, DELETION_CODE_LENGTH));
            flow.setCodeError(null);
          }}
          placeholder="123456"
          inputMode="numeric"
          autoComplete="one-time-code"
          invalid={flow.codeError !== null}
        />
      </FormField>
      <button
        type="button"
        className="self-start text-xs text-zinc-500 underline disabled:no-underline disabled:opacity-60"
        disabled={flow.busy || flow.resendSecondsLeft > 0}
        onClick={() => flow.challengeMutation.mutate()}
      >
        {flow.resendSecondsLeft > 0 ? `Resend code in ${flow.resendSecondsLeft}s` : 'Resend code'}
      </button>
    </>
  );
}

function PrimaryAction({ flow }: { flow: Flow }) {
  if (flow.step === 'confirm') {
    return (
      <Button
        id="delete-account-send-code-button"
        variant="destructive"
        className="flex-1"
        disabled={!flow.nameMatches || flow.busy}
        onClick={() => flow.challengeMutation.mutate()}
      >
        {flow.challengeMutation.isPending && <Spinner ariaLabel="Sending code" size={14} />}
        Send verification code
      </Button>
    );
  }
  return (
    <Button
      id="delete-account-confirm-button"
      variant="destructive"
      className="flex-1"
      disabled={!flow.codeComplete || flow.busy}
      onClick={() => flow.deleteMutation.mutate()}
    >
      {flow.deleteMutation.isPending && <Spinner ariaLabel="Deleting account" size={14} />}
      Permanently delete account
    </Button>
  );
}
