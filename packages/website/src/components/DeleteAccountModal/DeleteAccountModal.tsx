import { useState } from 'react';
import { DELETION_CODE_LENGTH, ApiErrorCode } from '@filone/shared';
import { Alert } from '../Alert';
import { Button } from '../Button';
import { Input } from '../Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../Modal';
import { confirmAccountDeletion, requestAccountDeletion } from '../../lib/api';

export type DeleteAccountModalProps = {
  open: boolean;
  onClose: () => void;
  orgName: string;
  /** Called once the deletion is accepted, so the caller can leave the app. */
  onDeleted: () => void;
};

type Step = 'warn' | 'confirm';

/**
 * Two steps, because the second factor arrives out of band: step one emails a
 * code, step two spends it alongside the typed org name.
 *
 * The code is kept in state across a step-up redirect on purpose — the confirm
 * route can answer 401 step_up_required after the user already holds a code, and
 * losing it would force a resend they are rate-limited on.
 */
export function DeleteAccountModal({ open, onClose, orgName, onDeleted }: DeleteAccountModalProps) {
  const [step, setStep] = useState<Step>('warn');
  const [code, setCode] = useState('');
  const [typedOrgName, setTypedOrgName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function reset() {
    setStep('warn');
    setCode('');
    setTypedOrgName('');
    setError(undefined);
    setBusy(false);
  }

  function close() {
    reset();
    onClose();
  }

  async function sendCode() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await requestAccountDeletion();
      // Already confirmed by someone: the account is going regardless, so show
      // the outcome rather than a code entry that can never succeed.
      if (result.outcome === 'deletion_in_progress') {
        onDeleted();
        return;
      }
      setStep('confirm');
    } catch (err) {
      setError(messageFor(err, 'We could not send the verification code.'));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      await confirmAccountDeletion({ code, orgName: typedOrgName });
      onDeleted();
    } catch (err) {
      setError(messageFor(err, 'We could not delete the account.'));
      // A spent or expired code cannot be retried — send them back for a new one.
      if (codeOf(err) === ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED) {
        setStep('warn');
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  }

  const canConfirm =
    code.trim().length === DELETION_CODE_LENGTH && typedOrgName.trim() === orgName && !busy;

  return (
    <Modal open={open} onClose={close} size="md" testId="delete-account-modal">
      <ModalHeader onClose={close} description={`This permanently deletes ${orgName}.`}>
        Delete this organization
      </ModalHeader>

      <ModalBody>
        <div className="flex flex-col gap-4">
          <Alert
            variant="red"
            title="This cannot be undone"
            description="Every bucket, object, access key and API key is destroyed, any subscription is cancelled, and your sign-in stops working. There is no restore."
          />

          {step === 'warn' ? (
            <p className="text-sm text-zinc-500">
              We will email a {DELETION_CODE_LENGTH}-digit verification code to confirm it is you.
            </p>
          ) : (
            <>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">Verification code</span>
                <Input
                  value={code}
                  onChange={setCode}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={DELETION_CODE_LENGTH}
                  placeholder={'0'.repeat(DELETION_CODE_LENGTH)}
                  aria-label="Verification code"
                />
                <span className="text-xs text-zinc-500">
                  Check the inbox for your sign-in email.
                </span>
              </label>

              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">
                  Type <span className="font-mono">{orgName}</span> to confirm
                </span>
                <Input
                  value={typedOrgName}
                  onChange={setTypedOrgName}
                  autoComplete="off"
                  placeholder={orgName}
                  aria-label="Organization name"
                />
              </label>
            </>
          )}

          {error && <Alert variant="red" description={error} />}
        </div>
      </ModalBody>

      <ModalFooter>
        <Button variant="ghost" onClick={close} disabled={busy}>
          Cancel
        </Button>
        {step === 'warn' ? (
          <Button variant="destructive" onClick={() => void sendCode()} disabled={busy}>
            {busy ? 'Sending code...' : 'Send verification code'}
          </Button>
        ) : (
          <Button variant="destructive" onClick={() => void confirm()} disabled={!canConfirm}>
            {busy ? 'Deleting...' : 'Delete organization'}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

function messageFor(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : undefined;
  return message ?? fallback;
}
