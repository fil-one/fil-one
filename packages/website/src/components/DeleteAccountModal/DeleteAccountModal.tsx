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
  /**
   * Whether this is the caller's only organization. Deleting an org always
   * destroys its data; it only takes the caller's login down with it when
   * they have nowhere else to land — otherwise they keep their account and
   * simply lose this one org.
   */
  soleMembership: boolean;
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
export function DeleteAccountModal({
  open,
  onClose,
  orgName,
  soleMembership,
  onDeleted,
}: DeleteAccountModalProps) {
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
            description={
              soleMembership
                ? 'Every bucket, object, access key and API key is destroyed, and any subscription is cancelled. This is your only organization, so your sign-in stops working too. There is no restore.'
                : 'Every bucket, object, access key and API key is destroyed, and any subscription is cancelled. You keep your account and sign-in — you only lose access to this organization. There is no restore.'
            }
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
