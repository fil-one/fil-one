import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../components/Button';
import { logout, getMe, resendVerificationEmail } from '../lib/api.js';
import type { MeResponse } from '@filone/shared';
import { queryKeys } from '../lib/query-client.js';

const RESEND_COOLDOWN_SECONDS = 60;

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

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  async function handleCheckAgain() {
    setError('');
    setChecking(true);
    try {
      // Force a token refresh so we pick up the latest email_verified claim from Auth0
      const updated = await getMe({ forceRefresh: true });
      if (updated.emailVerified) {
        // Force a hard reset so the cached me reflects the newly verified token
        void queryClient.resetQueries({ queryKey: queryKeys.me });
        onVerified();
      } else {
        setError(
          'Email not yet verified. Please check your inbox and click the verification link.',
        );
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Left panel — message */}
      <div className="relative flex w-full max-w-[480px] flex-col items-center justify-center bg-white px-8 py-12">
        {/* Top bar */}
        <div className="absolute top-0 right-0 left-0 flex items-center justify-between px-8 py-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
              F
            </span>
            <span className="text-sm font-semibold text-zinc-900">Fil.one</span>
          </div>
          <button
            type="button"
            onClick={logout}
            className="text-sm font-medium text-zinc-500 hover:text-zinc-700"
          >
            Log out
          </button>
        </div>

        <div className="flex w-full flex-col gap-6">
          {me.email && (
            <p className="text-sm text-zinc-500">
              Logged in as <span className="font-medium text-zinc-700">{me.email}</span>. Not you?{' '}
              <button
                type="button"
                onClick={logout}
                className="font-medium text-brand-600 hover:underline"
              >
                Sign out
              </button>
            </p>
          )}

          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold text-zinc-950">Verify your email</h1>
            <p className="text-sm text-zinc-500">
              We sent a verification email to{' '}
              <span className="font-medium text-zinc-700">{me.email}</span>. Please click the link
              in the email to verify your account, then come back here.
            </p>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <Button
            variant="filled"
            type="button"
            className="w-full justify-center"
            disabled={checking}
            onClick={handleCheckAgain}
          >
            {checking ? 'Checking...' : 'I verified my email'}
          </Button>

          <div className="flex flex-col gap-1">
            <p className="text-xs text-zinc-400">
              Didn't receive the email? Check your spam folder or resend it.
            </p>
            <button
              type="button"
              disabled={resending || resendCooldown > 0}
              onClick={async () => {
                setError('');
                setResending(true);
                try {
                  await resendVerificationEmail();
                  setResendCooldown(RESEND_COOLDOWN_SECONDS);
                } catch (err) {
                  setError(
                    err instanceof Error ? err.message : 'Failed to resend verification email.',
                  );
                } finally {
                  setResending(false);
                }
              }}
              className="text-xs font-medium text-brand-600 hover:underline disabled:cursor-not-allowed disabled:text-zinc-400 disabled:no-underline self-start"
            >
              {resending
                ? 'Sending...'
                : resendCooldown > 0
                  ? `Resend available in ${resendCooldown}s`
                  : 'Resend verification email'}
            </button>
          </div>
        </div>
      </div>

      {/* Right panel — branding */}
      <div className="hidden flex-1 flex-col items-center justify-center bg-zinc-50 px-12 py-16 lg:flex">
        <div className="mb-8 rounded-full bg-zinc-100 px-4 py-1.5 text-sm text-zinc-700">
          One more step
        </div>

        <h2 className="mb-4 max-w-sm text-center text-3xl font-semibold text-zinc-950">
          Verify your email
        </h2>

        <p className="mb-10 max-w-sm text-center text-base text-zinc-600">
          Email verification helps us keep your account secure and ensures you receive important
          notifications about your storage.
        </p>
      </div>
    </div>
  );
}
