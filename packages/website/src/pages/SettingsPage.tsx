import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';

import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { UserIcon, BellIcon, ShieldCheckIcon } from '@phosphor-icons/react/dist/ssr';

import { Heading } from '../components/Heading/Heading';
import { PageLayout } from '../components/PageLayout.js';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
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
  updatePreferences,
  updateProfile,
  DELETE_ACCOUNT_STEP_UP_ACTION,
} from '../lib/api.js';
import { DeleteAccountModal } from '../components/DeleteAccountModal';
import { getProvider, isSocialConnection, UpdateProfileSchema } from '@filone/shared';
import type { ConnectionProvider, MeResponse, PreferencesResponse } from '@filone/shared';
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
  value,
  provider,
}: {
  value: string;
  provider?: ConnectionProvider;
}) {
  return (
    <>
      <Input value={value} onChange={() => {}} disabled />
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
      ...(result.orgName !== undefined ? { orgName: result.orgName } : {}),
    };
  };
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
  const orgNameChanged = orgName !== (me.orgName ?? '');
  const hasChanges = nameChanged || emailChanged || orgNameChanged;

  const mutation = useMutation({
    mutationFn: updateProfile,
    onSuccess: (result) => {
      if (result.name !== undefined) setName(result.name);
      if (result.email !== undefined) setEmail(result.email);
      if (result.orgName !== undefined) setOrgName(result.orgName);

      const update = applyProfileUpdate(result);
      queryClient.setQueryData<MeResponse>(queryKeys.me, update);
      queryClient.setQueryData<MeResponse>(queryKeys.meWithMfa, update);

      if (result.email !== undefined) {
        // The cache update above means the verify-email page renders the
        // unverified state immediately, without a /me round-trip.
        void navigate({ to: '/verify-email' });
      } else {
        toast.success('Profile updated');
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update profile');
    },
  });

  function save() {
    const payload: Record<string, string> = {};
    if (nameChanged) payload.name = name;
    if (emailChanged) payload.email = email;
    if (orgNameChanged) payload.orgName = orgName;

    const validated = UpdateProfileSchema.safeParse(payload);
    if (!validated.success) {
      toast.error(validated.error.issues[0].message);
      return;
    }

    mutation.mutate(validated.data);
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
                <ProviderManagedField value={form.name} provider={provider} />
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
            <ProviderManagedField value={form.email} provider={provider} />
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
        <div className="opacity-50">
          <ToggleRow
            label="Email notifications"
            description="Get notified about your uploads and when approaching storage limits"
            enabled={false}
            disabled
          />
          <p className="text-xs text-zinc-400 italic">Coming soon</p>
        </div>
        <div className="h-px bg-[#e1e4ea]" />
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

  // Resume after a step-up redirect: the app root reads sessionStorage and
  // bounces here with ?action=delete-account — reopen the modal so the user
  // continues where they left off.
  const search = useSearch({ strict: false }) as { action?: string };
  const navigate = useNavigate();
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || search.action !== DELETE_ACCOUNT_STEP_UP_ACTION) return;
    resumed.current = true;
    void navigate({ to: '/settings', replace: true });
    setModalOpen(true);
  }, [search.action, navigate]);

  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-zinc-900">Delete account</p>
          <p className="text-xs text-zinc-500 mt-1">
            Permanently delete your account, organization, and all data. This cannot be undone.
          </p>
        </div>
        <Button
          id="settings-delete-account-button"
          variant="destructive"
          size="sm"
          onClick={() => setModalOpen(true)}
        >
          Delete account
        </Button>
      </div>
      <DeleteAccountModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        orgName={me.orgName}
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
