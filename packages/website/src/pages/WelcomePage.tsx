import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ORG_NAME_MAX_LENGTH, OrgNameSchema } from '@filone/shared';

import { AuthCard } from '../components/AuthCard';
import { Button } from '../components/Button';
import { FormField } from '../components/FormField';
import { Heading } from '../components/Heading/Heading';
import { Input } from '../components/Input';
import { errorMessageOf, logout, updateOrg } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';

/**
 * Text buttons carry no chrome, so they need their own keyboard-only ring.
 * Kept identical to the one on the verify page: the two gates sit back to back
 * in the same flow, and a differently styled escape hatch on each would read as
 * two different products.
 */
const textButton =
  'rounded-xs font-medium text-brand-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600';

type WelcomePageProps = {
  /** The derived name the account was created with, as the field's starting value. */
  suggestedName: string;
  /** The signed-in address, so the footer can name the account being committed to. */
  email?: string;
  /** Where to go once the name is saved. */
  onNamed: () => void;
};

/**
 * The one thing a new account is asked before it reaches the console.
 *
 * Framed as creation rather than naming. The organization row already exists,
 * written at first login, but nothing the caller can see says so: the gate
 * re-fires until this screen is finished, so from their side the organization
 * is not real until they name it. Calling it creation is what introduces the
 * concept that organizations are things you make, which is what the switcher
 * and a second organization depend on later.
 *
 * The field starts filled with the name derived at signup rather than empty, so
 * the common answer is Continue and nobody faces a blank box. Saving is an
 * ordinary `PATCH /api/org`, which is also what marks the name confirmed — so
 * this page needs no endpoint of its own, and a caller who reaches it twice
 * simply renames again.
 *
 * No avatar here. A monogram beside the field reads as a control and does
 * nothing, which is worse than its absence; it belongs on this screen only once
 * there is an upload behind it.
 */
export function WelcomePage({ suggestedName, email, onNamed }: WelcomePageProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(suggestedName);
  const [error, setError] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: (next: string) => updateOrg({ name: next }),
    onSuccess: async () => {
      // The gate in `_app` reads `nameConfirmed` off `/me`, so the cached copy
      // has to go before we navigate or the redirect bounces straight back.
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      onNamed();
    },
    onError: (err) => setError(errorMessageOf(err, 'We could not save that name.')),
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const parsed = OrgNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid organization name.');
      return;
    }

    setError(null);
    rename.mutate(parsed.data);
  }

  return (
    <AuthCard
      footer={
        // Which account this organization is about to belong to, and the way
        // out. Signing up on the wrong address is easiest to fix here, before
        // anything is named after it.
        email ? (
          <div className="text-center">
            <p className="text-xs text-(--color-paragraph-text)">Signed in as {email}</p>
            <p className="mt-1 text-xs text-(--color-paragraph-text-subtle)">
              Not your account?{' '}
              <button type="button" onClick={logout} className={textButton}>
                Sign out
              </button>
            </p>
          </div>
        ) : undefined
      }
    >
      <Heading tag="h1" size="lg" balance className="font-normal tracking-tight">
        Create your organization
      </Heading>
      <p className="mt-2 text-sm text-(--color-paragraph-text)">
        Manage your storage and invite others to collaborate.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-6">
        <FormField label="Organization name" htmlFor="welcome-org-name" error={error}>
          <Input
            id="welcome-org-name"
            value={name}
            onChange={setName}
            invalid={!!error}
            maxLength={ORG_NAME_MAX_LENGTH}
            autoFocus
            autoComplete="organization"
            disabled={rename.isPending}
          />
        </FormField>

        <Button
          type="submit"
          variant="primary"
          disabled={rename.isPending || name.trim() === ''}
          className="mt-6 w-full justify-center py-3.5"
        >
          {rename.isPending ? 'Creating...' : 'Create organization'}
        </Button>
      </form>
    </AuthCard>
  );
}
