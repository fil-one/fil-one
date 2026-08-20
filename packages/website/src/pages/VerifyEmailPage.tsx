import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckIcon } from '@phosphor-icons/react/dist/ssr';
import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { AuthCard } from '../components/AuthCard';
import { logout, getMe, resendVerificationEmail } from '../lib/api.js';
import type { MeResponse } from '@filone/shared';
import { queryKeys } from '../lib/query-client.js';

const RESEND_COOLDOWN_SECONDS = 60;

/** Long enough to register as an answer before the dashboard replaces the page. */
const VERIFIED_ACK_MS = 700;

/** Text buttons carry no chrome, so they need their own keyboard-only ring. */
const textButton =
  'rounded-xs font-medium text-brand-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600';

type VerifyEmailPageProps = {
  me: MeResponse;
  onVerified: () => void;
};

export function VerifyEmailPage({ me, onVerified }: VerifyEmailPageProps) {
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [verified, setVerified] = useState(false);
  // Holds the ack delay so it can be cleared if the page unmounts before it
  // fires, avoiding an onVerified() navigation on a gone component.
  const ackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(ackTimer.current), []);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const check = useCallback(
    async ({ silent }: { silent: boolean }) => {
      setError('');
      setChecking(true);
      try {
        // Force a token refresh so we pick up the latest email_verified claim from Auth0
        const updated = await getMe({ forceRefresh: true });
        if (updated.emailVerified) {
          // Force a hard reset so the cached me reflects the newly verified token
          void queryClient.resetQueries({ queryKey: queryKeys.me });
          // Confirm before leaving: navigating straight out gives the click no answer.
          setVerified(true);
          ackTimer.current = setTimeout(onVerified, VERIFIED_ACK_MS);
          return;
        }
        if (!silent) {
          setError('Not verified yet. Open the link in the email, then try again.');
        }
      } catch {
        if (!silent) setError('Something went wrong. Please try again.');
      } finally {
        setChecking(false);
      }
    },
    [queryClient, onVerified],
  );

  // Returning to the tab is the moment they've most likely just clicked the
  // link, so re-check then and spare them pressing the button at all.
  useEffect(() => {
    function onFocus() {
      if (document.visibilityState === 'visible') void check({ silent: true });
    }
    window.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [check]);

  async function handleResend() {
    setError('');
    setResending(true);
    try {
      await resendVerificationEmail();
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend verification email.');
    } finally {
      setResending(false);
    }
  }

  return (
    <AuthCard
      footer={
        // Account-level escape hatch belongs to the page, not the task.
        <p className="text-xs text-(--color-paragraph-text-subtle)">
          Not your account?{' '}
          <button type="button" onClick={logout} className={textButton}>
            Sign out
          </button>
        </p>
      }
    >
      <Heading
        id="verify-email-heading"
        tag="h1"
        size="lg"
        balance
        className="font-normal tracking-tight"
      >
        Verify your email to get started
      </Heading>
      <p className="mt-2 text-sm text-(--color-paragraph-text)">
        We sent a verification link to{' '}
        <span className="font-medium break-words text-(--color-paragraph-text-strong)">
          {me.email}
        </span>
        . Open it to finish setting up your account.
      </p>

      <Button
        id="verify-email-check-button"
        variant="primary"
        type="button"
        size="lg"
        icon={verified ? CheckIcon : undefined}
        // py-3.5 lifts the height past the lg default (~40px) to ~48px, matching
        // the taller Auth0 primary button so the two flows feel continuous.
        className="mt-6 w-full justify-center py-3.5"
        // Not `disabled` when verified: the greyed-out treatment reads as a
        // dead control, which is the opposite of the signal success needs.
        disabled={checking}
        aria-disabled={verified}
        onClick={() => {
          if (!verified) void check({ silent: false });
        }}
      >
        {verified ? 'Verified' : checking ? 'Checking…' : 'I verified my email'}
      </Button>

      {error && (
        <p role="alert" className="mt-3 text-xs text-red-600">
          {error}
        </p>
      )}

      <p className="mt-3 text-xs text-(--color-paragraph-text-subtle)">
        {resendCooldown > 0 ? (
          <>
            Didn't get it? You can resend in <span className="tabular-nums">{resendCooldown}s</span>
            .
          </>
        ) : (
          <>
            Didn't get it? Try your spam folder, or{' '}
            <button
              type="button"
              disabled={resending}
              onClick={handleResend}
              className={textButton}
            >
              {resending ? 'sending…' : 'resend'}
            </button>
            .
          </>
        )}
      </p>
    </AuthCard>
  );
}
