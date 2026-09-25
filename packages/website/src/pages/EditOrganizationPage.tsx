import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { OrgNameSchema } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { Button } from '../components/Button';
import { FormField } from '../components/FormField';
import { Input } from '../components/Input';
import { Link } from '../components/Link';
import { PageLayout } from '../components/PageLayout.js';
import { RequirePermission } from '../components/RequirePermission';
import { SectionCard } from '../components/SectionCard.js';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { errorMessageOf, getMe, updateOrg } from '../lib/api.js';
import { queryKeys, ME_STALE_TIME } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Identity: name
// ---------------------------------------------------------------------------

/**
 * Write a landed rename into every cache that reads it.
 *
 * Both `/me` keys, because Settings reads the one with MFA included and the
 * rest of the console reads the other, and `memberships` alongside `orgName`:
 * the switcher reads both from the list, so patching only the top
 * level renames the org in the header and leaves the switcher stale.
 *
 * `orgId` is the org the write was for. The top level is patched only while
 * that org is still the one `/me` describes: a save that lands after a switch
 * updates that org's row in the list and leaves the new org's name alone.
 */
function applyOrgUpdate(client: QueryClient, orgId: string, orgName: string): void {
  const change = {
    ...(orgName ? { orgName } : {}),
  };
  const patch = (old: MeResponse | undefined): MeResponse | undefined =>
    old
      ? {
          ...old,
          ...(old.orgId === orgId ? change : {}),
          memberships: old.memberships?.map((membership) =>
            membership.orgId === orgId ? { ...membership, ...change } : membership,
          ),
        }
      : old;

  client.setQueryData<MeResponse>(queryKeys.me, patch);
  client.setQueryData<MeResponse>(queryKeys.meWithMfa, patch);
}

/**
 * The name needs an explicit Save. Unlike the personal name field on Settings, a
 * rename here changes what every member of the org sees, which is enough of
 * a consequence that it shouldn't fire on a stray blur.
 */
function IdentitySection({ me }: { me: MeResponse }) {
  const { toast } = useToast();
  const client = useQueryClient();

  const [name, setName] = useState(me.orgName);
  const [error, setError] = useState<string | null>(null);

  // `me.orgName` lands once `/me` resolves, and this syncs the form to it the
  // same way a reopened dialog would, without needing an `open` flag now that
  // the surface is a page rather than a modal.
  useEffect(() => {
    setName(me.orgName);
  }, [me.orgName]);

  const nameMutation = useMutation({
    mutationFn: ({ next }: { next: string; orgId: string }) => updateOrg({ name: next }),
    onSuccess: (result, { orgId }) => {
      applyOrgUpdate(client, orgId, result.name);
      setName(result.name);
      toast.success(`This organization is called ${result.name} now`);
    },
    onError: (err) => {
      setError(errorMessageOf(err, 'Failed to save the organization'));
    },
  });

  // Against the trimmed value, because trimmed is what gets sent: otherwise a
  // trailing space alone counts as a change and the Save button never goes away.
  const changed = name.trim() !== me.orgName;

  function save() {
    const parsed = OrgNameSchema.safeParse(name.trim());
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setError(null);
    nameMutation.mutate({ next: parsed.data, orgId: me.orgId });
  }

  return (
    <SectionCard title="General">
      <div className="flex flex-col gap-4">
        <div className="flex items-end gap-3">
          <FormField
            label="Organization name"
            htmlFor="org-name"
            error={error ?? undefined}
            className="flex-1"
          >
            <Input
              id="org-name"
              value={name}
              invalid={!!error}
              disabled={nameMutation.isPending}
              onChange={(value) => {
                setName(value);
                if (error) setError(null);
              }}
              placeholder="Your organization"
            />
          </FormField>
          {changed && (
            // `lg`'s `py-2.5` is what actually lines up with Input `md`'s own
            // vertical padding - `md` (`py-2`) sits 4px shorter, the same
            // Button/Input drift DESIGN.md's control-height rule calls out.
            <Button size="lg" variant="primary" onClick={save} disabled={nameMutation.isPending}>
              {nameMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------

/**
 * No self-serve deletion yet (FIL-1135 covers what that flow needs to
 * account for across a caller's other memberships), so this points at
 * support the same way Settings' own Danger zone does, rather than a
 * disabled button in front of a modal nothing can open yet.
 */
function DangerSection({ me }: { me: MeResponse }) {
  return (
    <SectionCard title="Danger zone" bare>
      <div className="flex flex-col gap-3 px-5 pt-4 pb-4">
        <div className="py-1">
          <p className="text-sm font-medium text-zinc-900">Delete organization</p>
          <p className="text-xs text-zinc-500">
            To delete {me.orgName}, please email{' '}
            <Link href="mailto:support@fil.one" variant="accent">
              support@fil.one
            </Link>
            .
          </p>
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function OrganizationDetails() {
  const { data: me, isPending } = useQuery({
    queryKey: queryKeys.meWithMfa,
    queryFn: () => getMe({ include: 'mfa' }),
    staleTime: ME_STALE_TIME,
  });

  if (isPending || !me) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading organization" />
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <IdentitySection me={me} />
      <RequirePermission permission="org.delete">
        <DangerSection me={me} />
      </RequirePermission>
    </div>
  );
}

/**
 * Rename the organization or delete it — the two things
 * that are about the organization itself rather than who is in it (that's
 * `OrganizationPage`) or what it pays (`BillingPage`).
 *
 * Reached from the org switcher's "Edit organization" link rather than a
 * modal opened from it: a page gives Delete organization a permanent,
 * bookmarkable home instead of living inside a dialog meant for a quick
 * rename, and lets each section gate on its own permission — `org.rename`
 * for identity, `org.delete` (Owner-only) for the danger zone — the way
 * `RequirePermission` already gates other pages' surfaces.
 */
export function EditOrganizationPage() {
  return (
    <RequirePermission
      permission="org.rename"
      pending={
        <PageLayout title="Edit organization">
          <div className="flex items-center justify-center p-16">
            <Spinner ariaLabel="Loading organization" />
          </div>
        </PageLayout>
      }
      fallback={
        <PageLayout title="Edit organization">
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
            Organization details are managed by your organization&rsquo;s owners and admins.
          </div>
        </PageLayout>
      }
    >
      <PageLayout title="Edit organization">
        <OrganizationDetails />
      </PageLayout>
    </RequirePermission>
  );
}
