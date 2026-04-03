import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  CaretDownIcon,
  CaretUpIcon,
  PlusIcon,
  CheckIcon,
} from '@phosphor-icons/react/dist/ssr';

import { S3_REGION, CreateBucketSchema, CreateAccessKeySchema } from '@filone/shared';
import { apiRequest, createAccessKey } from '../lib/api.js';
import type { CreateBucketResponse } from '@filone/shared';
import { queryKeys } from '../lib/query-client.js';

import { AccessKeyFormFields } from '../components/AccessKeyFormFields';
import { Input } from '../components/Input';
import { SaveCredentialsModal } from '../components/SaveCredentialsModal';
import { useToast } from '../components/Toast';
import { useAccessKeyForm } from '../lib/use-access-key-form.js';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreateBucketPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Bucket fields
  const [name, setName] = useState('');
  const [region, setRegion] = useState(S3_REGION);

  // Key section visibility
  const [permissionsOpen, setPermissionsOpen] = useState(false);

  // Validation
  const [nameError, setNameError] = useState<string | null>(null);

  // Submit state
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<{
    accessKeyId: string;
    secretAccessKey: string;
  } | null>(null);

  const form = useAccessKeyForm({ onSuccess: () => {} });

  // When the key section opens, default to specific scope for this bucket
  useEffect(() => {
    if (!permissionsOpen) return;
    form.setBucketScope('specific');
  }, [permissionsOpen]); // form.setBucketScope is a stable useState setter

  // Track the previous bucket name so we can swap it in selectedBuckets when it changes
  const prevBucketNameRef = useRef('');

  // When the section opens, seed selectedBuckets with the current name.
  // When the name changes while open, swap the old name for the new one so that
  // any other buckets the user has selected are preserved.
  useEffect(() => {
    if (!permissionsOpen) return;
    const prev = prevBucketNameRef.current;
    const next = name.trim();
    prevBucketNameRef.current = next;
    form.setSelectedBuckets((buckets) => {
      const withoutPrev = prev ? buckets.filter((b) => b !== prev) : buckets;
      return next ? [...withoutPrev, next] : withoutPrev;
    });
  }, [name, permissionsOpen]); // form.setSelectedBuckets is a stable useState setter

  function validateName(value: string) {
    const result = CreateBucketSchema.shape.name.safeParse(value);
    if (!result.success) {
      setNameError(result.error.issues[0].message);
      return false;
    }
    setNameError(null);
    return true;
  }

  const wantsApiKey = permissionsOpen && form.keyName.trim().length > 0;

  async function handleSubmit() {
    if (!validateName(name)) return;
    if (wantsApiKey && form.permissions.length === 0) return;

    setCreating(true);

    // Step 1: Create the bucket
    let bucketName: string;
    try {
      const { bucket } = await apiRequest<CreateBucketResponse>('/buckets', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), region }),
      });
      bucketName = bucket.name;
      void queryClient.invalidateQueries({ queryKey: queryKeys.buckets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create bucket');
      setCreating(false);
      return;
    }

    // Step 2: Optionally create API key scoped to this bucket
    if (wantsApiKey) {
      const keyBody = {
        keyName: form.keyName.trim(),
        permissions: form.permissions,
        bucketScope: form.bucketScope,
        buckets: form.bucketScope === 'specific' ? form.selectedBuckets : undefined,
        expiresAt: form.expiresAt,
      };
      const parsed = CreateAccessKeySchema.safeParse(keyBody);
      if (!parsed.success) {
        toast.error(parsed.error.issues[0].message);
        setCreating(false);
        void navigate({ to: '/buckets/$bucketName', params: { bucketName } });
        return;
      }
      try {
        const keyResponse = await createAccessKey(parsed.data);
        void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
        setCredentials({
          accessKeyId: keyResponse.accessKeyId,
          secretAccessKey: keyResponse.secretAccessKey,
        });
        setCreating(false);
        return;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to create access key');
      }
    } else {
      toast.success('Bucket created successfully');
    }

    setCreating(false);
    void navigate({ to: '/buckets/$bucketName', params: { bucketName } });
  }

  function handleCredentialsDone() {
    setCredentials(null);
    void navigate({ to: '/buckets/$bucketName', params: { bucketName: name.trim() } });
  }

  const accessKeyNameValid = wantsApiKey
    ? CreateAccessKeySchema.shape.keyName.safeParse(form.keyName.trim()).success
    : true;

  const accessKeyFormValid =
    !wantsApiKey ||
    (accessKeyNameValid &&
      form.permissions.length > 0 &&
      (form.bucketScope !== 'specific' || form.selectedBuckets.length > 0));

  const canSubmit = name.trim().length > 0 && !nameError && !creating && accessKeyFormValid;

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
                onChange={(e) => setRegion(e.target.value as typeof S3_REGION)}
                disabled
                className="block w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-[13px] text-zinc-900 opacity-50 focus:outline-2 focus:outline-brand-600"
              >
                <option value={S3_REGION}>Europe (eu-west-1)</option>
              </select>
              <p className="text-[11px] text-zinc-500">More regions coming soon.</p>
            </div>

            {/* API key section */}
            <div className="flex flex-col gap-3">
              <label className="text-xs font-medium text-zinc-900">API key</label>

              {/* Clickable toggle header */}
              <button
                type="button"
                onClick={() => setPermissionsOpen(!permissionsOpen)}
                className="flex w-full items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-left hover:bg-zinc-100"
              >
                <div className="flex items-center gap-2">
                  <PlusIcon size={14} className="text-zinc-500" aria-hidden="true" />
                  <span className="text-[13px] text-zinc-900">Create new key</span>
                </div>
                {permissionsOpen ? (
                  <CaretUpIcon size={14} className="text-zinc-500" aria-hidden="true" />
                ) : (
                  <CaretDownIcon size={14} className="text-zinc-500" aria-hidden="true" />
                )}
              </button>

              {/* Expanded form */}
              {permissionsOpen && (
                <div className="rounded-lg border border-zinc-200 p-4">
                  <AccessKeyFormFields form={form} pinnedBucket={name.trim() || undefined} />
                </div>
              )}
            </div>

            {/* Submit button — full width */}
            <button
              type="button"
              disabled={!canSubmit}
              onClick={handleSubmit}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-700 px-4 pb-2 pt-3 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckIcon size={16} aria-hidden="true" />
              {creating
                ? 'Creating...'
                : wantsApiKey
                  ? 'Create bucket and access key'
                  : 'Create bucket'}
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
