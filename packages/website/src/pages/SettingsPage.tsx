import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { UserIcon, BellIcon, ShieldCheckIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';

import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { MfaSettings } from '../components/MfaSettings';
import { SettingRow } from '../components/SettingRow';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { getMe, updateProfile, changePassword } from '../lib/api.js';
import { getProvider, isSocialConnection, UpdateProfileSchema } from '@filone/shared';
import type { ConnectionProvider, MeResponse } from '@filone/shared';
import { queryKeys, ME_STALE_TIME } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Section card wrapper
// ---------------------------------------------------------------------------

function SectionCard({
  icon: IconComp,
  title,
  description,
  danger,
  children,
}: {
  icon: PhosphorIcon;
  title: string;
  description: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border bg-white shadow-sm ${
        danger ? 'border-red-200' : 'border-[#e1e4ea]'
      }`}
    >
      <div className="flex items-center gap-2.5 p-5 pb-0">
        <div
          className={`flex size-8 items-center justify-center rounded-lg ${
            danger ? 'bg-red-50' : 'bg-zinc-100'
          }`}
        >
          <IconComp size={16} className={danger ? 'text-red-600' : 'text-zinc-500'} />
        </div>
        <div>
          <Heading tag="h2" size="sm" className={danger ? 'text-red-600' : undefined}>
            {title}
          </Heading>
          <p className="text-[13px] text-zinc-500">{description}</p>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </div>
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
}: {
  label: string;
  description: string;
  enabled: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <div>
        <p className="text-[13px] font-medium text-zinc-900">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <div
        className={`flex h-6 w-11 items-center rounded-full border-2 border-transparent p-0.5 ${
          enabled ? 'bg-blue-500' : 'bg-zinc-300'
        } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
      >
        <div
          className={`size-5 rounded-full bg-white shadow transition-transform ${
            enabled ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </div>
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
      <p className="text-[11px] text-zinc-500">
        Managed by {provider?.label}.{' '}
        <a
          href={provider?.profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500 hover:underline"
        >
          Update at {provider?.label}
        </a>
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
      ...(result.email !== undefined ? { email: result.email } : {}),
      ...(result.orgName !== undefined ? { orgName: result.orgName } : {}),
    };
  };
}

function useProfileForm(me: MeResponse) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
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

      toast.success(
        result.email
          ? 'Profile updated. Check your inbox to verify your new email.'
          : 'Profile updated',
      );
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
          <div className="flex flex-1 flex-col gap-1.5">
            <label className="text-[13px] font-medium text-zinc-900">Full name</label>
            {social ? (
              <ProviderManagedField value={form.name} provider={provider} />
            ) : (
              <Input value={form.name} onChange={form.setName} placeholder="Your full name" />
            )}
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <label className="text-[13px] font-medium text-zinc-900">Company name</label>
            <Input value={form.orgName} onChange={form.setOrgName} placeholder="Your company" />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium text-zinc-900">Email</label>
          {social ? (
            <ProviderManagedField value={form.email} provider={provider} />
          ) : (
            <>
              <Input value={form.email} onChange={form.setEmail} placeholder="you@example.com" />
              <p className="text-[11px] text-zinc-500">You will need to verify any email change.</p>
            </>
          )}
        </div>

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
      <Button variant="primary" onClick={form.save} disabled={form.isSaving || !form.hasChanges}>
        {form.isSaving ? 'Saving...' : 'Save changes'}
      </Button>
      {form.hasChanges && <p className="text-[11px] text-zinc-500">Saving: {changedLabels}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications section
// ---------------------------------------------------------------------------

function NotificationsSection() {
  return (
    <SectionCard
      icon={BellIcon}
      title="Notifications"
      description="Manage your notification preferences"
    >
      <div className="flex flex-col gap-3 opacity-50">
        <ToggleRow
          label="Email notifications"
          description="Get notified about your uploads and when approaching storage limits"
          enabled={false}
          disabled
        />
        <div className="h-px bg-[#e1e4ea]" />
        <ToggleRow
          label="Marketing emails"
          description="Receive updates about new features"
          enabled={false}
          disabled
        />
        <p className="text-xs text-zinc-400 italic">Coming soon</p>
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
        <div className="h-px bg-[#e1e4ea]" />
        {!social && (
          <SettingRow
            label="Password"
            description="Change your account password"
            action={
              <Button
                variant="ghost"
                onClick={() => changePasswordMutation.mutate()}
                disabled={changePasswordMutation.isPending}
              >
                {changePasswordMutation.isPending ? 'Sending...' : 'Change'}
              </Button>
            }
          />
        )}
        {social && provider && (
          <p className="text-xs text-zinc-500">
            Password is managed by {provider.label}.{' '}
            <a
              href={provider.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline"
            >
              Visit {provider.label} settings
            </a>
          </p>
        )}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------

function DangerSection() {
  return (
    <SectionCard icon={TrashIcon} title="Danger zone" description="Irreversible actions" danger>
      <div className="rounded-lg border border-red-200 bg-red-50/50 p-3.5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-medium text-zinc-900">Delete account</p>
            <p className="text-xs text-zinc-500">Permanently delete your account and all data</p>
          </div>
          <Button variant="ghost" className="cursor-not-allowed opacity-40" disabled>
            Delete account
          </Button>
        </div>
      </div>
    </SectionCard>
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
    <div className="px-10 pt-10">
      <div className="mb-1">
        <Heading tag="h1" size="xl" description="Manage your profile and preferences">
          Settings
        </Heading>
      </div>

      <div className="mt-6 flex max-w-[672px] flex-col gap-6">
        <ProfileSection me={me} />
        <NotificationsSection />
        <SecuritySection me={me} />
        <DangerSection />
      </div>
    </div>
  );
}
