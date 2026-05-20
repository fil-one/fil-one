import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { UserIcon, BellIcon, ShieldCheckIcon } from '@phosphor-icons/react/dist/ssr';

import { Heading } from '../components/Heading/Heading';
import { Alert } from '../components/Alert';
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
      <Button variant="primary" onClick={form.save} disabled={form.isSaving || !form.hasChanges}>
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
  return (
    <SectionCard
      icon={BellIcon}
      title="Notifications"
      description="Manage your notification preferences"
    >
      <Alert variant="grey" description="Notification preferences coming soon." showIcon={false} />
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

function DangerSection() {
  return (
    <Card>
      <p className="text-sm font-medium text-zinc-900">Delete account</p>
      <p className="text-xs text-zinc-500 mt-1">
        To permanently delete your account and all data, email{' '}
        <Link href="mailto:support@fil.one" variant="accent">
          support@fil.one
        </Link>
      </p>
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
