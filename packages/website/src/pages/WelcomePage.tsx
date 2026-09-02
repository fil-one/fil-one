import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ORG_NAME_MAX_LENGTH, OrgNameSchema } from '@filone/shared';

import { AuthCard } from '../components/AuthCard';
import { Button } from '../components/Button';
import { FormField } from '../components/FormField';
import { Heading } from '../components/Heading/Heading';
import { Input } from '../components/Input';
import { UserAvatar } from '../components/UserAvatar';
import { errorMessageOf, updateOrg } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';

/**
 * The initials shown in the monogram, from the first two words of the name.
 *
 * Two letters rather than one because this stands for an organization rather
 * than a person, and "AC" tells two organizations apart where "A" does not.
 * Falls back to the first two characters for a single word, and to nothing at
 * all for an empty field, which is what keeps the monogram from flickering a
 * stale letter while somebody clears the input.
 */
export function orgInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

type WelcomePageProps = {
  /** The derived name the account was created with, as the field's starting value. */
  suggestedName: string;
  /** Where to go once the name is saved. */
  onNamed: () => void;
};

/**
 * The one thing a new account is asked before it reaches the console: what its
 * organization is called.
 *
 * The field starts filled with the name derived at signup rather than empty, so
 * the common answer is Continue and nobody faces a blank box. Saving is an
 * ordinary `PATCH /api/org`, which is also what marks the name confirmed — so
 * this page needs no endpoint of its own, and a caller who reaches it twice
 * simply renames again.
 *
 * The monogram beside the field is the organization's avatar, and it updates as
 * the name is typed. It is not asked for and cannot be uploaded here: it exists
 * so the name has something to be attached to, and so the field visibly matters.
 */
export function WelcomePage({ suggestedName, onNamed }: WelcomePageProps) {
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
    <AuthCard>
      <Heading tag="h1" size="lg" balance className="font-normal tracking-tight">
        Name your organization
      </Heading>
      <p className="mt-2 text-sm text-(--color-paragraph-text)">
        This is what your teammates see when you invite them, and what appears on your invoices. You
        can change it later in settings.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-6">
        {/* The monogram sits beside the input rather than beside the whole
            field, so the label stays flush with the heading above it. */}
        <FormField label="Organization name" htmlFor="welcome-org-name" error={error}>
          <div className="flex items-center gap-3">
            <UserAvatar initial={orgInitials(name)} className="h-10 w-10 rounded-xl text-sm" />
            <Input
              id="welcome-org-name"
              value={name}
              onChange={setName}
              invalid={!!error}
              maxLength={ORG_NAME_MAX_LENGTH}
              autoFocus
              autoComplete="organization"
              disabled={rename.isPending}
              className="min-w-0 flex-1"
            />
          </div>
        </FormField>

        <Button
          type="submit"
          variant="primary"
          disabled={rename.isPending || name.trim() === ''}
          className="mt-6 w-full justify-center py-3.5"
        >
          {rename.isPending ? 'Saving...' : 'Continue'}
        </Button>
      </form>
    </AuthCard>
  );
}
