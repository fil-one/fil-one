import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { UserIcon, BellIcon, ShieldCheckIcon } from '@phosphor-icons/react/dist/ssr';

import { Heading } from '../components/Heading/Heading';
import { PageLayout } from '../components/PageLayout.js';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DeleteAccountModal } from '../components/DeleteAccountModal';
import { ACCOUNT_DELETION_ENABLED } from '../lib/account-deletion';
import { IconBox } from '../components/IconBox';
import { FormField } from '../components/FormField';
import { Input } from '../components/Input';
import { Link } from '../components/Link';
import { MfaSettings } from '../components/MfaSettings';
import { SettingRow } from '../components/SettingRow';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import {
  changePassword,
  getMe,
  getPreferences,
  updateOrg,
  updatePreferences,
  updateProfile,
} from '../lib/api.js';
import {
  getProvider,
  isSocialConnection,
  OrgNameSchema,
  UpdateProfileSchema,
} from '@filone/shared';
import type {
  ConnectionProvider,
  MeResponse,
  PreferencesResponse,
  UpdateProfileRequest,
} from '@filone/shared';
import { queryKeys, ME_STALE_TIME } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Section card wrapper
// ---------------------------------------------------------------------------

function SectionCard({
  icon: IconComp,
  title,
  description,
  children,
}: {
  icon: PhosphorIcon;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card padding="none">
      <div className="flex items-center gap-2.5 p-5 pb-0">
        <IconBox icon={IconComp} color="blue" size="md" />
        <div>
          <Heading tag="h2" size="sm">
            {title}
          </Heading>
          <p className="text-sm text-zinc-500">{description}</p>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Toggle row (for notifications)
// ---------------------------------------------------------------------------

function ToggleRow({
  label,
  description,
  enabled,
  disabled,
  onChange,
  saving,
}: {
  label: string;
  description: string;
  enabled: boolean;
  disabled?: boolean;
  onChange?: () => void;
  saving?: boolean;
}) {
  const labelId = useId();
  const interactive = !disabled && !!onChange && !saving;
  return (
    <div className="flex items-center justify-between py-1">
      <div>
        <p id={labelId} className="text-[13px] font-medium text-zinc-900">
          {label}
        </p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-labelledby={labelId}
        disabled={!interactive}
        onClick={interactive ? onChange : undefined}
        className={`flex h-6 w-11 items-center rounded-full border-2 border-transparent p-0.5 transition-colors ${enabled ? 'bg-blue-500' : 'bg-zinc-300'} ${interactive ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
      >
        <div
          className={`size-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Managed-by-provider field (read-only with provider link)
// ---------------------------------------------------------------------------

function ProviderManagedField({
  id,
  value,
  provider,
}: {
  id: string;
  value: string;
  provider?: ConnectionProvider;
}) {
  return (
    <>
      <Input id={id} value={value} onChange={() => {}} disabled />
      <p className="text-xs text-zinc-500">
        Managed by {provider?.label}.{' '}
        <Link
          href={provider?.profileUrl ?? ''}
          variant="accent"
          target="_blank"
          rel="noopener noreferrer"
        >
          Update at {provider?.label}
        </Link>
      </p>
    </>
  );
}
// ---------------------------------------------------------------------------
// Profile section
// ---------------------------------------------------------------------------

function applyProfileUpdate(result: {
  name?: string;
  email?: string;
  orgName?: string;
}): (old: MeResponse | undefined) => MeResponse | undefined {
  return (old) => {
    if (!old) return old;
    return {
      ...old,
      ...(result.name !== undefined ? { name: result.name } : {}),
      // An email change always resets verification — reflect it immediately so
      // the verify-email gate in _app.tsx re-triggers without a /me round-trip.
      ...(result.email !== undefined ? { email: result.email, emailVerified: false } : {}),
      ...(result.orgName !== undefined
        ? {
            orgName: result.orgName,
            // The switcher reads the same name from `memberships`; patching one
            // and not the other renames the org in the header and leaves the
            // old name in the list until /me is refetched.
            memberships: old.memberships?.map((membership) =>
              membership.orgId === old.orgId
                ? { ...membership, orgName: result.orgName as string }
                : membership,
            ),
          }
        : {}),
    };
  };
}

/** What one Save press changed, whether or not the whole press succeeded. */
interface SavedFields {
  name?: string;
  email?: string;
  orgName?: string;
}

/**
 * A save where one call succeeded and the other did not.
 *
 * The two halves go to two endpoints and either can fail on its own — most
 * often the rename, which a Member is not allowed to make. Carrying what did
 * land keeps the page honest: the message names the half that failed, and the
 * half that succeeded still reaches the cache instead of being silently
 * discarded and reappearing on the next refetch.
 */
class PartialSaveError extends Error {
  constructor(
    message: string,
    readonly saved: SavedFields,
  ) {
    super(message);
    this.name = 'PartialSaveError';
  }
}

function messageFor(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * What one Save press sends. The personal fields go to `PATCH /api/me/profile`
 * and the org name to `PATCH /api/org`: two endpoints because they are two
 * permissions, and only the fields that changed are sent at all.
 *
 * Personal fields first. They are the caller's own and every role may change
 * them, while the rename is the call a Member's role refuses — running it
 * second means the likely failure cannot strand the likely success.
 */
async function saveProfileAndOrg({
  profile,
  orgName,
}: {
  profile: UpdateProfileRequest | undefined;
  orgName: string | undefined;
}): Promise<SavedFields> {
  const saved: SavedFields = {};

  if (profile !== undefined) {
    try {
      Object.assign(saved, await updateProfile(profile));
    } catch (err) {
      throw new PartialSaveError(messageFor(err, 'Failed to update your profile'), saved);
    }
  }

  if (orgName !== undefined) {
    try {
      saved.orgName = (await updateOrg({ name: orgName })).name;
    } catch (err) {
      throw new PartialSaveError(messageFor(err, 'Failed to rename the organization'), saved);
    }
  }

  return saved;
}

function useProfileForm(me: MeResponse) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const social = isSocialConnection(me.connectionType);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [orgName, setOrgName] = useState('');
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!initialized) {
      setName(me.name ?? '');
      setEmail(me.email ?? '');
      setOrgName(me.orgName ?? '');
      setInitialized(true);
    }
  }, [me, initialized]);

  const nameChanged = !social && name !== (me.name ?? '');
  const emailChanged = !social && email !== (me.email ?? '');
  // Against the trimmed value, because trimmed is what gets sent: otherwise a
  // trailing space alone counts as a change and the save renames the org to the
  // name it already has.
  const orgNameChanged = orgName.trim() !== (me.orgName ?? '');
  const hasChanges = nameChanged || emailChanged || orgNameChanged;

  /** Reflect what landed, in the form and in the cache the rest of the app reads. */
  function applySaved(saved: SavedFields) {
    if (saved.name !== undefined) setName(saved.name);
    if (saved.email !== undefined) setEmail(saved.email);
    if (saved.orgName !== undefined) setOrgName(saved.orgName);

    const update = applyProfileUpdate(saved);
    queryClient.setQueryData<MeResponse>(queryKeys.me, update);
    queryClient.setQueryData<MeResponse>(queryKeys.meWithMfa, update);
  }

  /**
   * Apply what landed, then follow a landed email change to the verify page.
   *
   * The redirect belongs to the email having changed, not to the press as a
   * whole having succeeded: a new address is unverified from the moment the
   * profile PATCH returns, and `_app.tsx`'s gate is a `beforeLoad` redirect that
   * never fires while the user stays on Settings. Both paths go through here so
   * they cannot drift apart again. Returns whether the redirect was issued.
   */
  function applyAndFollow(saved: SavedFields): boolean {
    applySaved(saved);
    if (saved.email === undefined) return false;
    // The cache update above means the verify-email page renders the unverified
    // state immediately, without a /me round-trip.
    void navigate({ to: '/verify-email' });
    return true;
  }

  const mutation = useMutation({
    mutationFn: saveProfileAndOrg,
    onSuccess: (saved) => {
      if (!applyAndFollow(saved)) toast.success('Profile updated');
    },
    onError: (err) => {
      // A half that succeeded is applied even though the press as a whole
      // failed; discarding it would show the old value until the next refetch
      // and invite the user to save it again. The error toast still names the
      // half that failed, on the verify page if that is where this lands.
      if (err instanceof PartialSaveError) applyAndFollow(err.saved);
      toast.error(messageFor(err, 'Failed to update profile'));
    },
  });

  function save() {
    let profile: UpdateProfileRequest | undefined;
    if (nameChanged || emailChanged) {
      const payload: Record<string, string> = {};
      if (nameChanged) payload.name = name;
      if (emailChanged) payload.email = email;

      const validated = UpdateProfileSchema.safeParse(payload);
      if (!validated.success) {
        toast.error(validated.error.issues[0].message);
        return;
      }
      profile = validated.data;
    }

    let nextOrgName: string | undefined;
    if (orgNameChanged) {
      const validated = OrgNameSchema.safeParse(orgName);
      if (!validated.success) {
        toast.error(validated.error.issues[0].message);
        return;
      }
      // The schema's own trimmed output, so the value stored is the value the
      // form was checked against.
      nextOrgName = validated.data;
    }

    mutation.mutate({ profile, orgName: nextOrgName });
  }

  return {
    name,
    setName,
    email,
    setEmail,
    orgName,
    setOrgName,
    nameChanged,
    emailChanged,
    orgNameChanged,
    hasChanges,
    isSaving: mutation.isPending,
    save,
  };
}

function ProfileSection({ me }: { me: MeResponse }) {
  const social = isSocialConnection(me.connectionType);
  const provider = getProvider(me.connectionType);
  const form = useProfileForm(me);

  return (
    <SectionCard icon={UserIcon} title="Profile" description="Your personal information">
      <div className="flex flex-col gap-4">
        <div className="flex gap-3">
          <div className="flex flex-1 flex-col">
            <FormField label="Full name" htmlFor="profile-name">
              {social ? (
                <ProviderManagedField id="profile-name" value={form.name} provider={provider} />
              ) : (
                <Input
                  id="profile-name"
                  value={form.name}
                  onChange={form.setName}
                  placeholder="Your full name"
                />
              )}
            </FormField>
          </div>
          <div className="flex flex-1 flex-col">
            <FormField label="Company name" htmlFor="profile-org-name">
              <Input
                id="profile-org-name"
                value={form.orgName}
                onChange={form.setOrgName}
                placeholder="Your company"
              />
            </FormField>
          </div>
        </div>

        <FormField
          label="Email"
          htmlFor="profile-email"
          description={!social ? 'You will need to verify any email change.' : undefined}
        >
          {social ? (
            <ProviderManagedField id="profile-email" value={form.email} provider={provider} />
          ) : (
            <Input
              id="profile-email"
              value={form.email}
              onChange={form.setEmail}
              placeholder="you@example.com"
            />
          )}
        </FormField>

        <ProfileSaveBar form={form} />
      </div>
    </SectionCard>
  );
}

function ProfileSaveBar({ form }: { form: ReturnType<typeof useProfileForm> }) {
  const changedLabels = [
    form.nameChanged && 'name',
    form.emailChanged && 'email',
    form.orgNameChanged && 'company name',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="flex items-center gap-3">
      <Button
        id="settings-save-button"
        variant="primary"
        onClick={form.save}
        disabled={form.isSaving || !form.hasChanges}
      >
        {form.isSaving ? 'Saving...' : 'Save changes'}
      </Button>
      {form.hasChanges && <p className="text-xs text-zinc-500">Saving: {changedLabels}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications section
// ---------------------------------------------------------------------------

function NotificationsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: prefs, isError } = useQuery({
    queryKey: queryKeys.preferences,
    queryFn: getPreferences,
  });

  const mutation = useMutation({
    mutationFn: updatePreferences,
    onSuccess: (result) => {
      queryClient.setQueryData<PreferencesResponse>(queryKeys.preferences, result);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update preferences');
    },
  });

  const marketingEnabled = prefs?.marketingEmailsOptedIn ?? false;

  return (
    <SectionCard
      icon={BellIcon}
      title="Notifications"
      description="Manage your notification preferences"
    >
      <div className="flex flex-col gap-3">
        <ToggleRow
          label="Marketing emails"
          description="Receive updates about new features"
          enabled={marketingEnabled}
          disabled={!prefs}
          saving={mutation.isPending}
          onChange={() => mutation.mutate({ marketingEmailsOptedIn: !marketingEnabled })}
        />
        {isError && (
          <p className="text-xs text-red-500">
            Couldn&apos;t load preferences. Refresh to try again.
          </p>
        )}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Security section
// ---------------------------------------------------------------------------

function SecuritySection({ me }: { me: MeResponse }) {
  const { toast } = useToast();
  const social = isSocialConnection(me.connectionType);
  const provider = getProvider(me.connectionType);

  const changePasswordMutation = useMutation({
    mutationFn: () => changePassword(),
    onSuccess: () => toast.success('Password reset email sent'),
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to send password reset email');
    },
  });

  return (
    <SectionCard icon={ShieldCheckIcon} title="Security" description="Manage your account security">
      <div className="flex flex-col gap-3">
        <MfaSettings me={me} />
        <div className="h-px bg-zinc-200" />
        {!social && (
          <SettingRow
            label="Password"
            description="Change your account password"
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => changePasswordMutation.mutate()}
                disabled={changePasswordMutation.isPending}
              >
                {changePasswordMutation.isPending ? 'Sending...' : 'Change'}
              </Button>
            }
          />
        )}
        {social && provider && (
          <div className="py-1">
            <p className="text-sm font-medium text-zinc-900">Password</p>
            <p className="text-xs text-zinc-500">
              Managed by {provider.label}.{' '}
              <Link
                href={provider.profileUrl}
                variant="accent"
                target="_blank"
                rel="noopener noreferrer"
              >
                Update at {provider.label}
              </Link>
            </p>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------

function DangerSection({ me }: { me: MeResponse }) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-zinc-900">Delete organization</p>
          <p className="text-xs text-zinc-500 mt-1">
            {ACCOUNT_DELETION_ENABLED ? (
              <>Permanently deletes {me.orgName} and everything in it. This cannot be undone.</>
            ) : (
              <>
                Not available yet. To delete {me.orgName}, email{' '}
                <Link href="mailto:support@fil.one" variant="accent">
                  support@fil.one
                </Link>
              </>
            )}
          </p>
        </div>
        <Button
          variant="destructive"
          disabled={!ACCOUNT_DELETION_ENABLED}
          onClick={() => setModalOpen(true)}
        >
          Delete
        </Button>
      </div>

      <DeleteAccountModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        orgName={me.orgName}
        // A full document load, not a router navigation: the session is dead, so
        // every cached query would refetch into a 410 on the way out.
        onDeleted={() => {
          window.location.href = '/account-deleted';
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const { data: me, isPending } = useQuery({
    queryKey: queryKeys.meWithMfa,
    queryFn: () => getMe({ include: 'mfa' }),
    staleTime: ME_STALE_TIME,
  });

  if (isPending || !me) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading settings" />
      </div>
    );
  }

  return (
    <PageLayout
      title="Settings"
      headingId="settings-heading"
      description="Manage your profile and preferences"
    >
      <div className="flex max-w-2xl flex-col gap-6">
        <ProfileSection me={me} />
        <NotificationsSection />
        <SecuritySection me={me} />
        <DangerSection me={me} />
      </div>
    </PageLayout>
  );
}
