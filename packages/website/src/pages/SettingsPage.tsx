import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/ssr';

import { Heading } from '../components/Heading/Heading';
import { PageLayout } from '../components/PageLayout.js';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { FormField } from '../components/FormField';
import { Input } from '../components/Input';
import { Link } from '../components/Link';
import { MfaSettings } from '../components/MfaSettings';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/Modal';
import { OrganizationsSection } from './OrganizationsSection.js';
import { ProfileAvatarPicker } from '../components/ProfileAvatarPicker.js';
import { SettingRow } from '../components/SettingRow';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import {
  changePassword,
  getMe,
  getPreferences,
  updatePreferences,
  updateProfile,
} from '../lib/api.js';
import { getProvider, isSocialConnection, UpdateProfileSchema } from '@filone/shared';
import type { ConnectionProvider, MeResponse, PreferencesResponse } from '@filone/shared';
import { queryKeys, ME_STALE_TIME } from '../lib/query-client.js';
import { usePatchProfileCache } from '../lib/profile-cache.js';

// ---------------------------------------------------------------------------
// Section card wrapper
// ---------------------------------------------------------------------------

function SectionCard({
  title,
  bare,
  children,
}: {
  title: string;
  /** Skips `Card`'s own padding, for a section that manages its own to keep its edges symmetric. */
  bare?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Heading tag="h2" size="sm">
        {title}
      </Heading>
      <Card padding={bare ? 'none' : 'md'}>{children}</Card>
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
        <p id={labelId} className="text-sm font-medium text-zinc-900">
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
        className={`flex h-6 w-11 items-center rounded-full border-2 border-transparent p-0.5 outline-none transition-colors focus-visible:brand-outline ${enabled ? 'bg-brand-600' : 'bg-zinc-300'} ${interactive ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
      >
        <div
          className={`size-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`}
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

function messageFor(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * The name autosaves on blur, the way Linear's own profile name does: it is
 * low-stakes and reversible, so a press-Save step in front of it is one more
 * thing to do for no protection it actually buys.
 */
function useNameAutosave(me: MeResponse) {
  const { toast } = useToast();
  const patchCache = usePatchProfileCache();
  const [name, setName] = useState(me.name ?? '');

  // A landed save (elsewhere, another tab) replaces whatever is here — this
  // field has no unsaved state of its own once a blur has either committed or
  // reverted it.
  useEffect(() => setName(me.name ?? ''), [me.name]);

  const mutation = useMutation({
    mutationFn: (next: string) => updateProfile({ name: next }),
    onSuccess: (saved) => {
      patchCache(saved);
      if (saved.name !== undefined) setName(saved.name);
      toast.success('Name updated');
    },
    onError: (err) => {
      toast.error(messageFor(err, 'Failed to update your name'));
      setName(me.name ?? '');
    },
  });

  function commit() {
    const trimmed = name.trim();
    if (trimmed === (me.name ?? '')) return;

    const validated = UpdateProfileSchema.safeParse({ name: trimmed });
    if (!validated.success) {
      toast.error(validated.error.issues[0].message);
      setName(me.name ?? '');
      return;
    }
    mutation.mutate(trimmed);
  }

  return { name, setName, commit, isSaving: mutation.isPending };
}

/**
 * The email, by contrast, goes through a modal rather than autosaving: it
 * resets `emailVerified` and starts a re-verification the moment it lands, so
 * a stray blur should not be able to trigger it the way it can for the name.
 */
function useEmailChangeModal(me: MeResponse) {
  const patchCache = usePatchProfileCache();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(me.email ?? '');
  const [error, setError] = useState<string | null>(null);

  // Reopening starts from the address on file, not whatever was last typed
  // and abandoned.
  useEffect(() => {
    if (open) {
      setEmail(me.email ?? '');
      setError(null);
    }
  }, [open, me.email]);

  const mutation = useMutation({
    mutationFn: (next: string) => updateProfile({ email: next }),
    onSuccess: (saved) => {
      patchCache(saved);
      setOpen(false);
      // The cache update above means the verify-email page renders the
      // unverified state immediately, without a /me round-trip.
      void navigate({ to: '/verify-email' });
    },
    onError: (err) => {
      setError(messageFor(err, 'Failed to update your email'));
    },
  });

  function submit() {
    const validated = UpdateProfileSchema.safeParse({ email });
    if (!validated.success) {
      setError(validated.error.issues[0].message);
      return;
    }
    setError(null);
    mutation.mutate(validated.data.email!);
  }

  return { open, setOpen, email, setEmail, error, submit, isSaving: mutation.isPending };
}

function EmailField({ email, onEdit }: { email: string; onEdit: () => void }) {
  return (
    <div className="group relative">
      {/* The whole field opens the modal, not just the icon — readOnly makes
          it a display, not an editable input, so a click anywhere on it (and
          Enter/Space once focused) is unambiguous. The icon underneath is
          decorative: `pointer-events-none` so it never steals the click, and
          `aria-hidden` since the input's own label already names the action. */}
      <Input
        id="profile-email"
        value={email}
        onChange={() => {}}
        readOnly
        aria-readonly
        onClick={onEdit}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onEdit();
        }}
        className="cursor-pointer pr-10"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100"
      >
        <PencilSimpleIcon size={14} />
      </span>
    </div>
  );
}

function ChangeEmailModal({ form }: { form: ReturnType<typeof useEmailChangeModal> }) {
  function close() {
    if (form.isSaving) return;
    form.setOpen(false);
  }

  return (
    <Modal open={form.open} onClose={close} size="sm" testId="change-email-modal">
      <ModalHeader onClose={close} description="You will need to verify your new address.">
        Change email
      </ModalHeader>
      <ModalBody>
        <FormField label="New email" htmlFor="new-email" error={form.error ?? undefined}>
          <Input
            id="new-email"
            value={form.email}
            invalid={!!form.error}
            disabled={form.isSaving}
            onChange={form.setEmail}
            placeholder="you@example.com"
          />
        </FormField>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button variant="ghost" onClick={close} disabled={form.isSaving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={form.submit} disabled={form.isSaving}>
          {form.isSaving ? 'Updating...' : 'Update'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function ProfileSection({ me }: { me: MeResponse }) {
  const social = isSocialConnection(me.connectionType);
  const provider = getProvider(me.connectionType);
  const nameForm = useNameAutosave(me);
  const emailForm = useEmailChangeModal(me);

  return (
    <SectionCard title="Profile">
      <div className="flex flex-col gap-4">
        <ProfileAvatarPicker me={me} />

        <FormField label="Name" htmlFor="profile-name">
          {social ? (
            <ProviderManagedField id="profile-name" value={nameForm.name} provider={provider} />
          ) : (
            <Input
              id="profile-name"
              value={nameForm.name}
              onChange={nameForm.setName}
              onBlur={nameForm.commit}
              disabled={nameForm.isSaving}
              placeholder="Your full name"
            />
          )}
        </FormField>

        <FormField label="Email" htmlFor="profile-email">
          {social ? (
            <ProviderManagedField id="profile-email" value={me.email ?? ''} provider={provider} />
          ) : (
            <EmailField email={me.email ?? ''} onEdit={() => emailForm.setOpen(true)} />
          )}
        </FormField>
      </div>

      {!social && <ChangeEmailModal form={emailForm} />}
    </SectionCard>
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
    <SectionCard title="Notifications" bare>
      {/* Same `pt-4`/`pb-4` compensation `SecuritySection` uses: `ToggleRow`'s
          own `py-1` already contributes 4px at the row, so 16+4 lands on the
          same 20px `px-5` gives the sides. */}
      <div className="flex flex-col gap-3 px-5 pt-4 pb-4">
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
    <SectionCard title="Security" bare>
      {/* `pt-4`/`pb-4` rather than `py-5`: `SettingRow`'s own `py-1` already
          contributes 4px at the first and last row, so 16+4 lands on the same
          20px `px-5` gives the sides — matching edges without reaching into
          `SettingRow`'s padding, which `MfaSettings` also depends on. */}
      <div className="flex flex-col gap-3 px-5 pt-4 pb-4">
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
        <OrganizationsSection me={me} />
        <NotificationsSection />
        <SecuritySection me={me} />
      </div>
    </PageLayout>
  );
}
