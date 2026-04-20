import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, CheckIcon } from '@phosphor-icons/react/dist/ssr';

import {
  S3_REGION,
  CreateBucketSchema,
  CreateAccessKeySchema,
  SubscriptionStatus,
} from '@filone/shared';
import type { CreateBucketResponse, RetentionMode, RetentionDurationType } from '@filone/shared';
import { apiRequest, createAccessKey, getBilling } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { daysUntil } from '../lib/time.js';

import { BucketApiKeysSection } from '../components/BucketApiKeysSection';
import { FormField } from '../components/FormField';
import { InfoSidebar } from '../components/InfoSidebar';
import { Heading } from '../components/Heading/Heading';
import { IconButton } from '../components/IconButton';
import { Input } from '../components/Input';
import { Select } from '../components/Select';
import { ObjectSettingsFields } from '../components/ObjectSettingsFields';
import { SaveCredentialsModal } from '../components/SaveCredentialsModal';
import { useToast } from '../components/Toast';
import { useAccessKeyForm } from '../lib/use-access-key-form.js';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// eslint-disable-next-line max-lines-per-function, complexity/complexity
export function CreateBucketPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Bucket fields
  const [name, setName] = useState('');
  const [region, setRegion] = useState(S3_REGION);

  // Object settings
  const [versioning, setVersioning] = useState(false);
  const [lock, setLock] = useState(false);
  const [retentionEnabled, setRetentionEnabled] = useState(false);
  const [retentionMode, setRetentionMode] = useState<RetentionMode>('governance');
  const [retentionDuration, setRetentionDuration] = useState(15);
  const [retentionDurationType, setRetentionDurationType] = useState<RetentionDurationType>('d');

  // API key section visibility
  const [createKeyOpen, setCreateKeyOpen] = useState(false);

  // Validation
  const [nameError, setNameError] = useState<string | null>(null);

  // Submit state
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<{
    accessKeyId: string;
    secretAccessKey: string;
  } | null>(null);

  const form = useAccessKeyForm({ onSuccess: () => {} });

  // Billing — used to surface trial constraints on retention period
  const { data: billing } = useQuery({ queryKey: queryKeys.billing, queryFn: getBilling });
  const isTrialing = billing?.subscription.status === SubscriptionStatus.Trialing;
  const trialDaysLeft =
    isTrialing && billing?.subscription.trialEndsAt
      ? daysUntil(billing.subscription.trialEndsAt)
      : null;

  // When the key section opens, default to specific scope for this bucket
  useEffect(() => {
    if (!createKeyOpen) return;
    form.setBucketScope('specific');
  }, [createKeyOpen]); // form.setBucketScope is a stable useState setter

  // Track the previous bucket name so we can swap it in selectedBuckets when it changes
  const prevBucketNameRef = useRef('');

  // When the section opens, seed selectedBuckets with the current name.
  // When the name changes while open, swap the old name for the new one so that
  // any other buckets the user has selected are preserved.
  useEffect(() => {
    if (!createKeyOpen) return;
    const prev = prevBucketNameRef.current;
    const next = name.trim();
    prevBucketNameRef.current = next;
    form.setSelectedBuckets((buckets) => {
      const withoutPrev = prev ? buckets.filter((b) => b !== prev) : buckets;
      return next ? [...withoutPrev, next] : withoutPrev;
    });
  }, [name, createKeyOpen]); // form.setSelectedBuckets is a stable useState setter

  function validateName(value: string) {
    const result = CreateBucketSchema.shape.name.safeParse(value);
    if (!result.success) {
      setNameError(result.error.issues[0].message);
      return false;
    }
    setNameError(null);
    return true;
  }

  const wantsApiKey = createKeyOpen && form.keyName.trim().length > 0;

  // eslint-disable-next-line complexity/complexity
  async function handleSubmit() {
    if (wantsApiKey && form.permissions.length === 0) return;

    const bucketBody = {
      name: name.trim(),
      region,
      versioning,
      lock,
      retention: retentionEnabled
        ? {
            enabled: true as const,
            mode: retentionMode,
            duration: retentionDuration,
            durationType: retentionDurationType,
          }
        : { enabled: false as const },
    };

    const parsed = CreateBucketSchema.safeParse(bucketBody);
    if (!parsed.success) {
      const msg = parsed.error.issues[0].message;
      // Show name errors inline; everything else as a toast
      if (parsed.error.issues[0].path[0] === 'name') {
        setNameError(msg);
      } else {
        toast.error(msg);
      }
      return;
    }

    setCreating(true);

    // Step 1: Create the bucket
    let bucketName: string;
    try {
      const { bucket } = await apiRequest<CreateBucketResponse>('/buckets', {
        method: 'POST',
        body: JSON.stringify(parsed.data),
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
    <div className="mx-auto flex max-w-[860px] flex-col gap-6 py-6">
      {/* Back + header */}
      <div className="flex items-center gap-4">
        <IconButton
          icon={ArrowLeftIcon}
          aria-label="Back to buckets"
          onClick={() => navigate({ to: '/buckets' })}
        />
        <Heading tag="h1" description="S3-compatible storage on Fil One">
          Create bucket
        </Heading>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-10">
        {/* Left: White card with form */}
        <div className="w-[520px] shrink-0 rounded-lg border border-(--input-border-color) bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-5">
            {/* Bucket name */}
            <FormField
              htmlFor="bucket-name"
              label="Bucket name"
              description="3-63 characters. Lowercase letters, numbers, and hyphens only. Must be globally unique."
              error={nameError ?? undefined}
            >
              <Input
                id="bucket-name"
                value={name}
                invalid={!!nameError}
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
            </FormField>

            {/* Region */}
            <FormField
              htmlFor="bucket-region"
              label="Region"
              description="More regions coming soon."
            >
              <Select
                id="bucket-region"
                value={region}
                onChange={(value) => setRegion(value as typeof S3_REGION)}
                disabled
              >
                <option value={S3_REGION}>Europe (eu-west-1)</option>
              </Select>
            </FormField>

            {/* Object settings */}
            <ObjectSettingsFields
              versioning={versioning}
              onVersioningChange={setVersioning}
              lock={lock}
              onLockChange={setLock}
              retentionEnabled={retentionEnabled}
              onRetentionEnabledChange={setRetentionEnabled}
              retentionMode={retentionMode}
              onRetentionModeChange={setRetentionMode}
              retentionDuration={retentionDuration}
              onRetentionDurationChange={setRetentionDuration}
              retentionDurationType={retentionDurationType}
              onRetentionDurationTypeChange={setRetentionDurationType}
              trialDaysLeft={trialDaysLeft}
            />

            {/* API key section */}
            <BucketApiKeysSection
              bucketName={name.trim()}
              form={form}
              createOpen={createKeyOpen}
              onCreateOpenChange={setCreateKeyOpen}
            />

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

        {/* Right: Info sidebar */}
        <div className="sticky top-0 w-60 shrink-0 self-start pt-1">
          <InfoSidebar
            heading="Included by default"
            items={[
              {
                title: 'Encryption',
                description: 'All data is encrypted at rest by default.',
              },
              {
                title: 'Private',
                description: 'All buckets are private by default. Access requires an API key.',
              },
            ]}
          />
        </div>
      </div>

      {/* Save credentials modal */}
      {credentials && (
        <SaveCredentialsModal
          open={true}
          onDone={handleCredentialsDone}
          credentials={credentials}
        />
      )}
    </div>
  );
}
