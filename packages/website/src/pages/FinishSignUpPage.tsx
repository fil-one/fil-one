import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Input } from '../components/Input';
import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { confirmOrg, logout } from '../lib/api.js';
import { ORG_NAME_PATTERN, ORG_NAME_MIN_LENGTH, ORG_NAME_MAX_LENGTH } from '@filone/shared';
import type { MeResponse } from '@filone/shared';
import { queryKeys } from '../lib/query-client.js';

type FinishSignUpPageProps = {
  me: MeResponse;
  onComplete: () => void;
};

export function FinishSignUpPage({ me, onComplete }: FinishSignUpPageProps) {
  const queryClient = useQueryClient();
  const [orgName, setOrgName] = useState(me.orgName || me.suggestedOrgName || '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = orgName.trim();
    if (!trimmed) {
      setError('Organization name is required.');
      return;
    }
    if (trimmed.length < ORG_NAME_MIN_LENGTH) {
      setError(`Organization name must be at least ${ORG_NAME_MIN_LENGTH} characters.`);
      return;
    }
    if (trimmed.length > ORG_NAME_MAX_LENGTH) {
      setError(`Organization name must be at most ${ORG_NAME_MAX_LENGTH} characters.`);
      return;
    }
    if (!ORG_NAME_PATTERN.test(trimmed)) {
      setError(
        'Organization name can only contain letters, numbers, spaces, hyphens, and periods.',
      );
      return;
    }

    setError('');
    setSubmitting(true);
    try {
      await confirmOrg(trimmed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Left panel — form */}
      <div className="relative flex w-full max-w-[480px] flex-col items-center justify-center bg-white px-8 py-12">
        {/* Top bar — user info + logout */}
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
          {/* Logged-in banner */}
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

          {/* Heading */}
          <div className="flex flex-col gap-1">
            <Heading tag="h1" size="xl">
              Finish setting up your account
            </Heading>
            <p className="text-sm text-zinc-500">
              Give your organization a name to get started. You can change this later in settings.
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="org-name" className="text-sm font-medium text-zinc-700">
                Organization name
              </label>
              <Input
                id="org-name"
                type="text"
                placeholder="Acme Inc."
                value={orgName}
                onChange={setOrgName}
                required
                autoFocus
                autoComplete="organization"
              />
              {error && <p className="text-xs text-red-600">{error}</p>}
              <p className="text-xs text-zinc-500">This is the name of your team or company.</p>
            </div>

            <Button
              variant="primary"
              type="submit"
              className="w-full justify-center"
              disabled={submitting}
            >
              {submitting ? 'Creating...' : 'Continue'}
            </Button>
          </form>
        </div>
      </div>

      {/* Right panel — branding */}
      <div className="hidden flex-1 flex-col items-center justify-center bg-zinc-50 px-12 py-16 lg:flex">
        <div className="mb-8 rounded-full bg-zinc-100 px-4 py-1.5 text-sm text-zinc-700">
          Almost there!
        </div>

        <Heading tag="h2" size="3xl" balance className="mb-4 max-w-sm text-center">
          Welcome to Fil One
        </Heading>

        <p className="mb-10 max-w-sm text-center text-base text-zinc-600">
          S3-compatible storage on Filecoin. Start storing objects with integrity you can verify.
        </p>

        <ul className="mb-12 flex w-full max-w-sm flex-col gap-4">
          <li className="flex items-center gap-3">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600 text-sm font-bold">
              1
            </span>
            <span className="text-sm text-zinc-700">Name your organization</span>
          </li>
          <li className="flex items-center gap-3">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-400 text-sm font-bold">
              2
            </span>
            <span className="text-sm text-zinc-400">Create your first bucket</span>
          </li>
          <li className="flex items-center gap-3">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-400 text-sm font-bold">
              3
            </span>
            <span className="text-sm text-zinc-400">Upload your first object</span>
          </li>
        </ul>

        <p className="text-sm text-zinc-400">
          Trusted by teams storing critical enterprise and AI data.
        </p>
      </div>
    </div>
  );
}
