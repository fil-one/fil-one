import { useEffect, useState } from 'react';

import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { UserIcon, BellIcon, ShieldCheckIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { getMe, updateProfile, changePassword } from '../lib/api.js';
import { getProvider, isSocialConnection, UpdateProfileSchema } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

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
          <h2
            className={`text-sm font-medium tracking-tight ${
              danger ? 'text-red-600' : 'text-zinc-900'
            }`}
          >
            {title}
          </h2>
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
// Setting row (for security section)
// ---------------------------------------------------------------------------

function SettingRow({
  label,
  description,
  action,
}: {
  label: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <div>
        <p className="text-[13px] font-medium text-zinc-900">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const { toast } = useToast();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [orgName, setOrgName] = useState('');
  const [saving, setSaving] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      try {
        const data = await getMe();
        if (!cancelled) {
          setMe(data);
          setName(data.name ?? '');
          setEmail(data.email ?? '');
          setOrgName(data.orgName ?? '');
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : 'Failed to load settings');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetch();
    return () => {
      cancelled = true;
    };
  }, []);

  const social = isSocialConnection(me?.connectionType);
  const provider = getProvider(me?.connectionType);

  const nameChanged = !social && name !== (me?.name ?? '');
  const emailChanged = !social && email !== (me?.email ?? '');
  const orgNameChanged = orgName !== (me?.orgName ?? '');
  const hasChanges = nameChanged || emailChanged || orgNameChanged;

  async function handleSaveProfile() {
    const payload: Record<string, string> = {};
    if (nameChanged) payload.name = name;
    if (emailChanged) payload.email = email;
    if (orgNameChanged) payload.orgName = orgName;

    const validated = UpdateProfileSchema.safeParse(payload);
    if (!validated.success) {
      toast.error(validated.error.issues[0].message);
      return;
    }

    setSaving(true);
    try {
      const result = await updateProfile(validated.data);
      const updated = { ...me } as MeResponse;
      if (result.name !== undefined) {
        setName(result.name);
        updated.name = result.name;
      }
      if (result.email !== undefined) {
        setEmail(result.email);
        updated.email = result.email;
      }
      if (result.orgName !== undefined) {
        setOrgName(result.orgName);
        updated.orgName = result.orgName;
      }
      setMe(updated);

      if (result.email && result.email !== me?.email) {
        toast.success('Profile updated. Check your inbox to verify your new email.');
      } else {
        toast.success('Profile updated');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  }

  async function handleChangePassword() {
    setChangingPassword(true);
    try {
      await changePassword();
      toast.success('Password reset email sent');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send password reset email');
    } finally {
      setChangingPassword(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading settings" />
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-1">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900">Settings</h1>
        <p className="text-[13px] text-zinc-500">Manage your profile and preferences</p>
      </div>

      <div className="mt-6 flex max-w-[672px] flex-col gap-6">
        {/* Profile */}
        <SectionCard icon={UserIcon} title="Profile" description="Your personal information">
          <div className="flex flex-col gap-4">
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <label className="text-[13px] font-medium text-zinc-900">Full name</label>
                {social ? (
                  <>
                    <Input value={name} onChange={() => {}} disabled />
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
                ) : (
                  <Input value={name} onChange={setName} placeholder="Your full name" />
                )}
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <label className="text-[13px] font-medium text-zinc-900">Company name</label>
                <Input value={orgName} onChange={setOrgName} placeholder="Your company" />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium text-zinc-900">Email</label>
              {social ? (
                <>
                  <Input value={email} onChange={() => {}} disabled />
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
              ) : (
                <>
                  <Input value={email} onChange={setEmail} placeholder="you@example.com" />
                  <p className="text-[11px] text-zinc-500">
                    You will need to verify any email change.
                  </p>
                </>
              )}
            </div>

            <div className="flex items-center gap-3">
              <Button variant="filled" onClick={handleSaveProfile} disabled={saving || !hasChanges}>
                {saving ? 'Saving...' : 'Save changes'}
              </Button>
              {hasChanges && (
                <p className="text-[11px] text-zinc-500">
                  Saving:{' '}
                  {[
                    nameChanged && 'name',
                    emailChanged && 'email',
                    orgNameChanged && 'company name',
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              )}
            </div>
          </div>
        </SectionCard>

        {/* Notifications */}
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

        {/* Security */}
        <SectionCard
          icon={ShieldCheckIcon}
          title="Security"
          description="Manage your account security"
        >
          <div className="flex flex-col gap-3">
            {!social && (
              <>
                <SettingRow
                  label="Two-factor authentication"
                  description="Add an extra layer of security to your account"
                  action={
                    <Button variant="ghost" size="compact" disabled>
                      Enable
                    </Button>
                  }
                />
                <p className="text-[11px] text-zinc-400 -mt-1">
                  Requires Auth0 MFA configuration. Coming soon.
                </p>
                <div className="h-px bg-[#e1e4ea]" />
              </>
            )}
            {!social && (
              <SettingRow
                label="Password"
                description="Change your account password"
                action={
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={handleChangePassword}
                    disabled={changingPassword}
                  >
                    {changingPassword ? 'Sending...' : 'Change'}
                  </Button>
                }
              />
            )}
            {social && provider && (
              <p className="text-xs text-zinc-500">
                Security settings are managed by {provider.label}.{' '}
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

        {/* Danger Zone */}
        <SectionCard icon={TrashIcon} title="Danger zone" description="Irreversible actions" danger>
          <div className="rounded-lg border border-red-200 bg-red-50/50 p-3.5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] font-medium text-zinc-900">Delete account</p>
                <p className="text-xs text-zinc-500">
                  Permanently delete your account and all data
                </p>
              </div>
              <Button variant="ghost" className="cursor-not-allowed opacity-40" disabled>
                Delete account
              </Button>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
