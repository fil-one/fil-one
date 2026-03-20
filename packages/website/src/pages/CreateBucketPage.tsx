import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  LockIcon,
  ShieldCheckIcon,
  CaretDownIcon,
  CaretUpIcon,
} from '@phosphor-icons/react/dist/ssr';

import type {
  AccessKeyPermission,
  CreateBucketResponse,
  CreateAccessKeyResponse,
} from '@filone/shared';
import { S3_REGION } from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { expiresAtFromForm } from '../lib/time.js';

import { Button } from '../components/Button';
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

  // New key fields
  const [keyName, setKeyName] = useState('');
  const [permissions, setPermissions] = useState<AccessKeyPermission[]>([
    'read',
    'write',
    'list',
    'delete',
  ]);
  const [expiration, setExpiration] = useState<ExpirationOption>('never');
  const [customDate, setCustomDate] = useState<string | null>(null);

  // Permissions section expand/collapse
  const [permissionsOpen, setPermissionsOpen] = useState(true);

  // Submit state
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<{
    accessKeyId: string;
    secretAccessKey: string;
  } | null>(null);

  async function handleSubmit() {
    if (!name.trim() || !keyName.trim()) return;

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

    // Step 2: Create API key scoped to this bucket
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
    } catch (err) {
      console.error('Failed to create access key:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to create access key');
      // Bucket was created successfully — navigate to it
      void navigate({ to: '/buckets/$bucketName', params: { bucketName: name.trim() } });
    } finally {
      setCreating(false);
    }
  }

  function handleCredentialsDone() {
    setCredentials(null);
    void navigate({ to: '/buckets/$bucketName', params: { bucketName: name.trim() } });
  }

  const canSubmit =
    name.trim().length > 0 && keyName.trim().length > 0 && permissions.length > 0 && !creating;

  return (
    <div className="p-6">
      {/* Back link */}
      <button
        type="button"
        onClick={() => navigate({ to: '/buckets' })}
        className="mb-4 flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900"
      >
        <ArrowLeftIcon size={14} aria-hidden="true" />
        Back to buckets
      </button>

      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-900">Create bucket</h1>
        <p className="mt-1 text-sm text-zinc-500">S3-compatible storage on Filecoin</p>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-8">
        {/* Left: Form */}
        <div className="flex flex-1 flex-col gap-6">
          {/* Bucket name */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="bucket-name" className="text-sm font-medium text-zinc-700">
              Bucket name
            </label>
            <Input
              id="bucket-name"
              value={name}
              onChange={setName}
              placeholder="my-storage-bucket"
              autoComplete="off"
            />
            <p className="text-xs text-zinc-500">
              Lowercase letters, numbers, and hyphens only. Must be globally unique.
            </p>
          </div>

          {/* Region */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="bucket-region" className="text-sm font-medium text-zinc-700">
              Region
            </label>
            <select
              id="bucket-region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="block w-full rounded-lg border border-zinc-200 p-3 text-zinc-900 focus:outline-2 focus:outline-brand-600"
            >
              <option value={S3_REGION}>EU Ireland ({S3_REGION})</option>
            </select>
            <p className="text-xs text-zinc-500">More regions coming soon.</p>
          </div>

          {/* Divider */}
          <hr className="border-zinc-200" />

          {/* API Key section */}
          <div className="flex flex-col gap-4">
            <div>
              <label className="text-sm font-medium text-zinc-700">API key</label>
              <p className="mt-0.5 text-xs text-zinc-500">
                Create a new key to access this bucket via the S3 API.
              </p>
            </div>

            {/* Key name */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="key-name" className="text-sm font-medium text-zinc-700">
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

            {/* Collapsible permissions section */}
            <div className="rounded-lg border border-zinc-200">
              <button
                type="button"
                onClick={() => setPermissionsOpen(!permissionsOpen)}
                className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Configure key permissions
                {permissionsOpen ? (
                  <CaretUpIcon size={14} aria-hidden="true" />
                ) : (
                  <CaretDownIcon size={14} aria-hidden="true" />
                )}
              </button>
              {permissionsOpen && (
                <div className="border-t border-zinc-200 px-4 py-3">
                  <div className="mb-4">
                    <p className="mb-2 text-xs font-medium text-zinc-600">Permissions</p>
                    <AccessKeyPermissionsFields value={permissions} onChange={setPermissions} />
                    {permissions.length === 0 && (
                      <p className="mt-1 text-xs text-red-600">Select at least one permission.</p>
                    )}
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-medium text-zinc-600">Expiration</p>
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
          </div>

          {/* Submit button */}
          <Button
            variant="filled"
            icon={CheckCircleIcon}
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {creating ? 'Creating...' : 'Create bucket'}
          </Button>
        </div>

        {/* Right: Info sidebar */}
        <div className="w-64 shrink-0">
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-5">
            <p className="mb-4 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
              Included by default
            </p>
            <div className="flex flex-col gap-5">
              <div className="flex gap-3">
                <LockIcon size={20} className="mt-0.5 shrink-0 text-zinc-500" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-zinc-900">Object Lock</p>
                  <p className="mt-0.5 text-[11px] font-medium text-brand-600">Always on</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    All objects are immutable by default. Data cannot be modified or deleted during
                    the retention period.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <ShieldCheckIcon
                  size={20}
                  className="mt-0.5 shrink-0 text-zinc-500"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-medium text-zinc-900">Encryption</p>
                  <p className="mt-0.5 text-[11px] font-medium text-brand-600">Always on</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    All objects are encrypted at rest using AES-256 server-side encryption.
                  </p>
                </div>
              </div>
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
