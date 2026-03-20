import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/ssr';

import type {
  AccessKeyBucketScope,
  AccessKeyPermission,
  CreateAccessKeyResponse,
} from '@filone/shared';
import { CreateAccessKeySchema } from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { expiresAtFromForm } from '../lib/time.js';
import { AccessKeyExpirationFields } from '../components/AccessKeyExpirationFields.js';
import type { ExpirationOption } from '../components/AccessKeyExpirationFields.js';
import { AccessKeyBucketScopeFields } from '../components/AccessKeyBucketScopeFields.js';
import { AccessKeyPermissionsFields } from '../components/AccessKeyPermissionsFields.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SaveCredentialsModal } from '../components/SaveCredentialsModal.js';
import { useToast } from '../components/Toast/index.js';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CreateApiKeyPage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [keyName, setKeyName] = useState('');
  const [permissions, setPermissions] = useState<AccessKeyPermission[]>(['read', 'write', 'list']);
  const [bucketScope, setBucketScope] = useState<AccessKeyBucketScope>('all');
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>([]);
  const [expiration, setExpiration] = useState<ExpirationOption>('never');
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<{
    accessKeyId: string;
    secretAccessKey: string;
  } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      keyName: keyName.trim(),
      permissions,
      bucketScope,
      buckets: bucketScope === 'specific' ? selectedBuckets : undefined,
      expiresAt: expiresAtFromForm(expiration, customDate),
    };
    const parsed = CreateAccessKeySchema.safeParse(body);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setCreating(true);
    try {
      const response = await apiRequest<CreateAccessKeyResponse>('/access-keys', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setCredentials({
        accessKeyId: response.accessKeyId,
        secretAccessKey: response.secretAccessKey,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create access key');
    } finally {
      setCreating(false);
    }
  }

  function handleCredentialsDone() {
    void navigate({ to: '/api-keys' });
  }

  const bucketsValid = bucketScope === 'all' || selectedBuckets.length > 0;
  const canSubmit =
    keyName.trim().length > 0 && permissions.length > 0 && bucketsValid && !creating;

  return (
    <>
      <div className="mx-auto max-w-4xl p-8">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void navigate({ to: '/api-keys' })}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Back to API keys"
          >
            <ArrowLeftIcon size={16} />
          </button>
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">Create API key</h1>
            <p className="text-sm text-zinc-500">
              Generate credentials for S3-compatible API access
            </p>
          </div>
        </div>

        {/* Two-column layout */}
        <div className="flex gap-8">
          {/* Left: form */}
          <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-6">
            <div className="rounded-lg border border-zinc-200 bg-white p-6">
              <div className="flex flex-col gap-6">
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
                  />
                  <p className="text-xs text-zinc-500">
                    A descriptive name helps identify this key in your list.
                  </p>
                </div>

                {/* Permissions */}
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-zinc-700">What can this key do?</label>
                  <AccessKeyPermissionsFields value={permissions} onChange={setPermissions} />
                  {permissions.length === 0 && (
                    <p className="text-xs text-red-600">Select at least one permission.</p>
                  )}
                </div>

                {/* Bucket scope */}
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-zinc-700">
                    Which buckets can this key access?
                  </label>
                  <p className="text-xs text-zinc-500">
                    Restrict access to specific buckets or allow all
                  </p>
                  <AccessKeyBucketScopeFields
                    bucketScope={bucketScope}
                    onBucketScopeChange={setBucketScope}
                    selectedBuckets={selectedBuckets}
                    onSelectedBucketsChange={setSelectedBuckets}
                  />
                </div>

                {/* Expiration */}
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-zinc-700">
                    When should it expire?
                  </label>
                  <p className="text-xs text-zinc-500">Set an expiration date for added security</p>
                  <AccessKeyExpirationFields
                    value={expiration}
                    customDate={customDate}
                    onChange={setExpiration}
                    onDateChange={setCustomDate}
                  />
                </div>
              </div>
            </div>

            <Button type="submit" variant="filled" disabled={!canSubmit}>
              {creating ? 'Creating...' : 'Create API key'}
            </Button>
          </form>

          {/* Right: info panel */}
          <div className="w-64 shrink-0">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Good to know
            </p>
            <p className="mb-4 text-sm font-medium text-zinc-700">
              Keep these in mind when creating keys.
            </p>
            <div className="flex flex-col gap-4 text-sm text-zinc-600">
              <div>
                <p className="mb-1 font-medium text-zinc-800">Keep your secret safe</p>
                <p>
                  Your secret access key grants full access to your data. Never share it with
                  anyone, including support. Store it in a secure location like a password manager
                  or secrets vault.
                </p>
              </div>
              <div>
                <p className="mb-1 font-medium text-zinc-800">Scope by bucket</p>
                <p>Restrict keys to specific buckets to follow the principle of least privilege.</p>
              </div>
              <div>
                <p className="mb-1 font-medium text-zinc-800">Set an expiry</p>
                <p>
                  Keys can be set to expire automatically. Use short-lived keys for temporary
                  access.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {credentials && (
        <SaveCredentialsModal
          open={true}
          onClose={handleCredentialsDone}
          onDone={handleCredentialsDone}
          credentials={credentials}
        />
      )}
    </>
  );
}
