import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  CaretDownIcon,
  CaretUpIcon,
  PlusIcon,
} from '@phosphor-icons/react/dist/ssr';

import type {
  AccessKeyPermission,
  CreateBucketResponse,
  CreateAccessKeyResponse,
} from '@filone/shared';
import { S3_REGION, CreateBucketSchema } from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { expiresAtFromForm } from '../lib/time.js';

import { Input } from '../components/Input';
import { AccessKeyPermissionsFields } from '../components/AccessKeyPermissionsFields';
import { AccessKeyExpirationFields } from '../components/AccessKeyExpirationFields';
import type { ExpirationOption } from '../components/AccessKeyExpirationFields';
import { SaveCredentialsModal } from '../components/SaveCredentialsModal';
import { useToast } from '../components/Toast';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreateBucketPage() {
  const { toast } = useToast();
  const navigate = useNavigate();

  // Bucket fields
  const [name, setName] = useState('');
  const [region, setRegion] = useState(S3_REGION);

  // API key fields
  const [keyName, setKeyName] = useState('');
  const [permissions, setPermissions] = useState<AccessKeyPermission[]>([
    'read',
    'write',
    'list',
    'delete',
  ]);
  const [expiration, setExpiration] = useState<ExpirationOption>('never');
  const [customDate, setCustomDate] = useState<string | null>(null);

  // Permissions section collapsed by default
  const [permissionsOpen, setPermissionsOpen] = useState(false);

  // Validation
  const [nameError, setNameError] = useState<string | null>(null);

  function validateName(value: string) {
    const result = CreateBucketSchema.shape.name.safeParse(value);
    if (!result.success) {
      setNameError(result.error.issues[0].message);
      return false;
    }
    setNameError(null);
    return true;
  }

  // Submit state
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<{
    accessKeyId: string;
    secretAccessKey: string;
  } | null>(null);

  // Only create an API key if the user has expanded and filled out the section
  const wantsApiKey = permissionsOpen && keyName.trim().length > 0;

  async function handleSubmit() {
    if (!validateName(name)) return;
    if (wantsApiKey && permissions.length === 0) return;

    setCreating(true);

    // Step 1: Create the bucket
    try {
      await apiRequest<CreateBucketResponse>('/buckets', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), region }),
      });
    } catch (err) {
      console.error('Failed to create bucket:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to create bucket');
      setCreating(false);
      return;
    }

    // Step 2: Optionally create API key scoped to this bucket
    if (wantsApiKey) {
      try {
        const keyResponse = await apiRequest<CreateAccessKeyResponse>('/access-keys', {
          method: 'POST',
          body: JSON.stringify({
            keyName: keyName.trim(),
            permissions,
            bucketScope: 'specific',
            buckets: [name.trim()],
            expiresAt: expiresAtFromForm(expiration, customDate),
          }),
        });
        setCredentials({
          accessKeyId: keyResponse.accessKeyId,
          secretAccessKey: keyResponse.secretAccessKey,
        });
        setCreating(false);
        return;
      } catch (err) {
        console.error('Failed to create access key:', err);
        toast.error(err instanceof Error ? err.message : 'Failed to create access key');
      }
    } else {
      toast.success('Bucket created successfully');
    }

    setCreating(false);
    void navigate({ to: '/buckets/$bucketName', params: { bucketName: name.trim() } });
  }

  function handleCredentialsDone() {
    setCredentials(null);
    void navigate({ to: '/buckets/$bucketName', params: { bucketName: name.trim() } });
  }

  const canSubmit = name.trim().length > 0 && !nameError && !creating;

  return (
    <div className="p-6">
      {/* Back + header */}
      <div className="mb-6 flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate({ to: '/buckets' })}
          className="flex size-9 items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900"
        >
          <ArrowLeftIcon size={16} aria-hidden="true" />
        </button>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">Create bucket</h1>
          <p className="text-[13px] text-zinc-500">S3-compatible storage on Filecoin</p>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-10">
        {/* Left: White card with form */}
        <div className="w-[520px] shrink-0 overflow-hidden rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-5">
            {/* Bucket name */}
            <div className="flex flex-col gap-2.5">
              <label htmlFor="bucket-name" className="text-xs font-medium text-zinc-900">
                Bucket name
              </label>
              <Input
                id="bucket-name"
                value={name}
                onChange={(v) => {
                  setName(v);
                  if (nameError) validateName(v);
                }}
                onBlur={() => {
                  if (name.trim()) validateName(name);
                }}
                placeholder="my-storage-bucket"
                autoComplete="off"
              />
              {nameError ? (
                <p className="text-[11px] leading-relaxed text-red-600">{nameError}</p>
              ) : (
                <p className="text-[11px] leading-relaxed text-zinc-500">
                  3-63 characters. Lowercase letters, numbers, and hyphens only. Must be globally
                  unique.
                </p>
              )}
            </div>

            {/* Region */}
            <div className="flex flex-col gap-2.5">
              <label htmlFor="bucket-region" className="text-xs font-medium text-zinc-900">
                Region
              </label>
              <select
                id="bucket-region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                disabled
                className="block w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-[13px] text-zinc-900 opacity-50 focus:outline-2 focus:outline-brand-600"
              >
                <option value={S3_REGION}>EU (Ireland)</option>
              </select>
              <p className="text-[11px] text-zinc-500">More regions coming soon.</p>
            </div>

            {/* API key section */}
            <div className="flex flex-col gap-3">
              <label className="text-xs font-medium text-zinc-900">API key</label>

              {/* Dropdown-styled selector */}
              <div className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <PlusIcon size={14} className="text-zinc-500" aria-hidden="true" />
                  <span className="text-[13px] text-zinc-900">Create new key</span>
                </div>
              </div>

              {/* Configure key permissions toggle */}
              <button
                type="button"
                onClick={() => setPermissionsOpen(!permissionsOpen)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700"
              >
                {permissionsOpen ? (
                  <CaretUpIcon size={14} aria-hidden="true" />
                ) : (
                  <CaretDownIcon size={14} aria-hidden="true" />
                )}
                Configure key permissions
              </button>

              {/* Expanded permissions */}
              {permissionsOpen && (
                <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-4">
                  {/* Key name */}
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="key-name" className="text-xs font-medium text-zinc-900">
                      Key name
                    </label>
                    <Input
                      id="key-name"
                      value={keyName}
                      onChange={setKeyName}
                      placeholder="e.g., Production API Key"
                      autoComplete="off"
                    />
                  </div>

                  {/* Permissions */}
                  <div className="flex flex-col gap-2">
                    <p className="text-xs font-medium text-zinc-600">Permissions</p>
                    <AccessKeyPermissionsFields value={permissions} onChange={setPermissions} />
                    {permissions.length === 0 && (
                      <p className="text-xs text-red-600">Select at least one permission.</p>
                    )}
                  </div>

                  {/* Expiration */}
                  <div className="flex flex-col gap-2">
                    <p className="text-xs font-medium text-zinc-600">Expiration</p>
                    <AccessKeyExpirationFields
                      value={expiration}
                      customDate={customDate}
                      onChange={setExpiration}
                      onDateChange={setCustomDate}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Submit button — full width */}
            <button
              type="button"
              disabled={!canSubmit}
              onClick={handleSubmit}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-gradient-to-br from-brand-600 to-[#256af4] px-4 py-3 text-[13px] font-medium text-white shadow-sm transition-colors hover:from-brand-700 hover:to-[#2060d8] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckCircleIcon size={16} aria-hidden="true" />
              {creating ? 'Creating...' : 'Create bucket'}
            </button>
          </div>
        </div>

        {/* Right: Info sidebar (no box, just text) */}
        <div className="w-60 shrink-0 pt-1">
          <p className="text-[10px] font-semibold uppercase tracking-[1px] text-zinc-500">
            Included by default
          </p>
          <p className="mt-1 text-xs font-medium text-zinc-900">
            Every bucket comes with these features built in.
          </p>

          <div className="mt-4 flex flex-col gap-0.5">
            {/* Object Lock */}
            <div className="py-3">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-zinc-900">Object Lock</span>
                <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-600">
                  Always on
                </span>
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                All objects are immutable once written — protected against overwrites, deletion, and
                ransomware. Compliance mode, 30-day retention.
              </p>
            </div>

            <hr className="border-zinc-200/60" />

            {/* Encryption */}
            <div className="py-3">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-zinc-900">Encryption</span>
                <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-600">
                  Always on
                </span>
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                All data is encrypted at rest by default for both private and public buckets.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Save credentials modal */}
      {credentials && (
        <SaveCredentialsModal
          open={true}
          onClose={handleCredentialsDone}
          onDone={handleCredentialsDone}
          credentials={credentials}
        />
      )}
    </div>
  );
}
