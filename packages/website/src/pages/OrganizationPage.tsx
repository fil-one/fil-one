import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { OrgNameSchema } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { AvatarPicker, useOrgLogoUpload } from '../components/OrgLogoPicker.js';
import { Button } from '../components/Button';
import { DeleteAccountModal } from '../components/DeleteAccountModal';
import { FormField } from '../components/FormField';
import { Input } from '../components/Input';
import { Link } from '../components/Link';
import { PageLayout } from '../components/PageLayout.js';
import { RequirePermission } from '../components/RequirePermission';
import { SectionCard } from '../components/SectionCard.js';
import { SettingRow } from '../components/SettingRow';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { ACCOUNT_DELETION_ENABLED } from '../lib/account-deletion.js';
import { errorMessageOf, getMe, updateOrg } from '../lib/api.js';
import { queryKeys, ME_STALE_TIME } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Identity: logo and name
// ---------------------------------------------------------------------------

/**
 * Write a landed rename and/or logo change into every cache that reads them.
 *
 * Both `/me` keys, because Settings reads the one with MFA included and the
 * rest of the console reads the other, and `memberships` alongside `orgName`/
 * `logoUrl`: the switcher reads both from the list, so patching only the top
 * level renames the org in the header and leaves the switcher stale.
 */
function applyOrgUpdate(client: QueryClient, orgName: string, logoUrl?: string): void {
  const patch = (old: MeResponse | undefined): MeResponse | undefined =>
    old
      ? {
          ...old,
          orgName,
          ...(logoUrl !== undefined ? { logoUrl } : {}),
          memberships: old.memberships?.map((membership) =>
            membership.orgId === old.orgId
              ? { ...membership, orgName, ...(logoUrl !== undefined ? { logoUrl } : {}) }
              : membership,
          ),
        }
      : old;

  client.setQueryData<MeResponse>(queryKeys.me, patch);
  client.setQueryData<MeResponse>(queryKeys.meWithMfa, patch);
}

/** The name is what most saves are about; a logo-only save gets its own toast. */
function saveMessage(newName: string, previousName: string): string {
  return newName !== previousName
    ? `This organization is called ${newName} now`
    : 'Organization logo updated';
}

function IdentitySection({ me }: { me: MeResponse }) {
  const { toast } = useToast();
  const client = useQueryClient();

  const [name, setName] = useState(me.orgName);
  const [error, setError] = useState<string | null>(null);
  const logo = useOrgLogoUpload(me.logoUrl);

  // `me.orgName`/`me.logoUrl` land once `/me` resolves — this syncs the form
  // to them the same way a reopened dialog would, without needing an `open`
  // flag now that the surface is a page rather than a modal.
  useEffect(() => {
    setName(me.orgName);
    logo.reset(me.logoUrl);
    // `logo` is a fresh object every render; only the org identity itself
    // (name, logo) is what this effect resyncs to.
  }, [me.orgName, me.logoUrl]);

  const rename = useMutation({
    mutationFn: (next: string) => updateOrg({ name: next, logoUrl: logo.logoUrl }),
    onSuccess: (result) => {
      applyOrgUpdate(client, result.name, result.logoUrl);
      toast.success(saveMessage(result.name, me.orgName));
    },
    onError: (err) => {
      setError(errorMessageOf(err, 'Failed to save the organization'));
    },
  });

  // Against the trimmed value, because trimmed is what gets sent: otherwise a
  // trailing space alone counts as a change and the save renames the org to
  // the name it already has.
  const nameChanged = name.trim() !== me.orgName;
  const logoChanged = logo.logoUrl !== me.logoUrl;
  const changed = nameChanged || logoChanged;

  function save() {
    const parsed = OrgNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setError(null);
    rename.mutate(parsed.data);
  }

  const busy = rename.isPending || logo.uploading;

  return (
    <SectionCard title="Identity">
      <div className="flex flex-col gap-4">
        <AvatarPicker name={name} logo={logo} disabled={busy} />
        <FormField label="Organization name" htmlFor="org-name" error={error ?? undefined}>
          <Input
            id="org-name"
            value={name}
            invalid={!!error}
            disabled={busy}
            onChange={(value) => {
              setName(value);
              if (error) setError(null);
            }}
            placeholder="Your organization"
          />
        </FormField>
        <div className="flex items-center gap-3">
          <Button id="org-save-button" variant="primary" onClick={save} disabled={busy || !changed}>
            {busy ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------

function DangerSection({ me }: { me: MeResponse }) {
  const [modalOpen, setModalOpen] = useState(false);
  // Deleting an org always destroys its data; it only takes the caller's
  // login down with it when they have nowhere else to land.
  const soleMembership = (me.memberships?.length ?? 1) <= 1;

  return (
    <SectionCard title="Danger zone" bare>
      <div className="flex flex-col gap-3 px-5 pt-4 pb-4">
        <SettingRow
          label="Delete organization"
          description={
            ACCOUNT_DELETION_ENABLED ? (
              <>Permanently deletes {me.orgName} and everything in it. This cannot be undone.</>
            ) : (
              <>
                Not available yet. To delete {me.orgName}, email{' '}
                <Link href="mailto:support@fil.one" variant="accent">
                  support@fil.one
                </Link>
              </>
            )
          }
          action={
            <Button
              variant="destructive"
              disabled={!ACCOUNT_DELETION_ENABLED}
              onClick={() => setModalOpen(true)}
            >
              Delete
            </Button>
          }
        />
      </div>

      <DeleteAccountModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        orgName={me.orgName}
        soleMembership={soleMembership}
        // A full document load, not a router navigation: the session is dead, so
        // every cached query would refetch into a 410 on the way out.
        onDeleted={() => {
          window.location.href = '/account-deleted';
        }}
      />
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
 * Rename the organization, replace its logo, or delete it — the three things
 * that are about the organization itself rather than who is in it (that's
 * `MembersPage`) or what it pays (`BillingPage`).
 *
 * Reached from the org switcher's "Edit organization" link rather than a
 * modal opened from it: a page gives Delete organization a permanent,
 * bookmarkable home instead of living inside a dialog meant for a quick
 * rename, and lets each section gate on its own permission — `org.rename`
 * for identity, `org.delete` (Owner-only) for the danger zone — the way
 * `RequirePermission` already gates other pages' surfaces.
 */
export function OrganizationPage() {
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
