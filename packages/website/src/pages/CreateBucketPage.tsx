import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  CaretDownIcon,
  CaretUpIcon,
  PlusIcon,
} from '@phosphor-icons/react/dist/ssr';

import {
  S3_REGION,
  CreateBucketSchema,
  CreateAccessKeySchema,
  DOCS_URL,
  getAvailableRegions,
  getRegionLabel,
} from '@filone/shared';
import type { CreateBucketResponse, RetentionMode, RetentionDurationType } from '@filone/shared';
import { apiRequest, createAccessKey } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';

import { Heading } from '../components/Heading/Heading';
import { Card } from '../components/Card';
import { AccessKeyFormFields } from '../components/AccessKeyFormFields';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { FormField } from '../components/FormField';
import { Overline } from '../components/Overline';
import { Input } from '../components/Input';
import { RegionSelect } from '../components/RegionSelect';
import { FILONE_STAGE } from '../env.js';
import { ObjectSettingsFields } from '../components/ObjectSettingsFields';
import { SaveCredentialsModal } from '../components/SaveCredentialsModal';
import { SlowOperationIndicator } from '../components/SlowOperationIndicator';
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

  // Key section visibility
  const [createKeyToggled, setCreateKeyToggled] = useState(false);

  // Validation
  const [nameError, setNameError] = useState<string | null>(null);

  // Submit state
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<{
    accessKeyId: string;
    secretAccessKey: string;
  } | null>(null);

  const form = useAccessKeyForm({ region, onSuccess: () => {} });

  // When the key section opens, default to specific scope for this bucket
  useEffect(() => {
    if (!createKeyToggled) return;
    form.setBucketScope('specific');
  }, [createKeyToggled]); // form.setBucketScope is a stable useState setter

  // Track the previous bucket name so we can swap it in selectedBuckets when it changes
  const prevBucketNameRef = useRef('');

  // When the section opens, seed selectedBuckets with the current name.
  // When the name changes while open, swap the old name for the new one so that
  // any other buckets the user has selected are preserved.
  useEffect(() => {
    if (!createKeyToggled) return;
    const prev = prevBucketNameRef.current;
    const next = name.trim();
    prevBucketNameRef.current = next;
    form.setSelectedBuckets((buckets) => {
      const withoutPrev = prev ? buckets.filter((b) => b !== prev) : buckets;
      return next ? [...withoutPrev, next] : withoutPrev;
    });
  }, [name, createKeyToggled, region]); // form.setSelectedBuckets is a stable useState setter

  function validateName(value: string) {
    const result = CreateBucketSchema.shape.name.safeParse(value);
    if (!result.success) {
      setNameError(result.error.issues[0].message);
      return false;
    }
    setNameError(null);
    return true;
  }

  // eslint-disable-next-line complexity/complexity
  async function handleSubmit() {
    if (createKeyToggled && form.permissions.length === 0) return;

    const bucketBody = {
      name: name.trim(),
      region,
      versioning,
      lock,
      ...(retentionEnabled
        ? {
            retention: {
              enabled: true as const,
              mode: retentionMode,
              duration: retentionDuration,
              durationType: retentionDurationType,
            },
          }
        : {}),
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
    if (createKeyToggled) {
      const keyBody = {
        keyName: form.keyName.trim(),
        permissions: form.permissions,
        bucketScope: form.bucketScope,
        buckets: form.bucketScope === 'specific' ? form.selectedBuckets : undefined,
        region,
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

  const accessKeyNameValid = createKeyToggled
    ? CreateAccessKeySchema.shape.keyName.safeParse(form.keyName.trim()).success
    : true;

  const accessKeyFormValid =
    !createKeyToggled ||
    (accessKeyNameValid &&
      form.permissions.length > 0 &&
      (form.bucketScope !== 'specific' || form.selectedBuckets.length > 0));

  const canSubmit = name.trim().length > 0 && !nameError && !creating && accessKeyFormValid;

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-6 py-12">
      {/* Back + header */}
      <div className="flex items-center gap-4">
        <IconButton
          icon={ArrowLeftIcon}
          aria-label="Back to buckets"
          onClick={() => navigate({ to: '/buckets' })}
        />
        <Heading tag="h1" description="S3-compatible storage on Filecoin">
          Create bucket
        </Heading>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-10">
        {/* Left: White card with form */}
        <Card className="w-[520px] shrink-0 overflow-hidden">
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
              description={
                getAvailableRegions(FILONE_STAGE).length === 1
                  ? 'More regions coming soon.'
                  : undefined
              }
            >
              <RegionSelect id="bucket-region" value={region} onChange={setRegion} />
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
            />

            {/* API key section */}
            <div className="flex flex-col gap-3">
              <label className="text-xs font-medium text-zinc-900">API key</label>

              {/* Clickable toggle header */}
              <button
                type="button"
                onClick={() => setCreateKeyToggled(!createKeyToggled)}
                className="flex w-full items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-left hover:bg-zinc-100"
              >
                <div className="flex items-center gap-2">
                  <PlusIcon size={14} className="text-zinc-500" aria-hidden="true" />
                  <span className="text-sm text-zinc-900">Create new key</span>
                </div>
                {createKeyToggled ? (
                  <CaretUpIcon size={14} className="text-zinc-500" aria-hidden="true" />
                ) : (
                  <CaretDownIcon size={14} className="text-zinc-500" aria-hidden="true" />
                )}
              </button>

              {/* Expanded form */}
              {createKeyToggled && (
                <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4">
                  <p className="text-xs leading-relaxed text-zinc-600">
                    This key will only work with buckets in{' '}
                    <span className="text-zinc-900">{getRegionLabel(region)}</span>{' '}
                    <span className="text-zinc-500">{region}</span>.{' '}
                    <a
                      href={DOCS_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-brand-600 hover:underline"
                    >
                      Learn more
                    </a>
                  </p>
                  <AccessKeyFormFields
                    form={form}
                    pinnedBucket={name.trim() || undefined}
                    region={region}
                  />
                </div>
              )}
            </div>

            {/* Submit button */}
            <Button variant="primary" size="lg" disabled={!canSubmit} onClick={handleSubmit}>
              {creating
                ? 'Creating...'
                : createKeyToggled
                  ? 'Create bucket and API key'
                  : 'Create bucket'}
            </Button>
            <SlowOperationIndicator isLoading={creating} operation="Creating bucket" />
          </div>
        </Card>

        {/* Right: Info sidebar */}
        <div className="sticky top-0 w-60 shrink-0 self-start pt-1">
          <Overline>Included by default</Overline>

          <div className="mt-3 flex flex-col">
            {/* Encryption */}
            <div className="flex flex-col gap-0.5 py-3">
              <span className="text-sm font-medium text-zinc-900">Encryption</span>
              <p className="text-xs leading-relaxed text-zinc-500">
                All data is encrypted at rest.
              </p>
            </div>

            {/* Private */}
            <div className="flex flex-col gap-0.5 border-t border-zinc-200/60 py-3">
              <span className="text-sm font-medium text-zinc-900">Private</span>
              <p className="text-xs leading-relaxed text-zinc-500">
                All buckets are private. Access requires an API key.
              </p>
            </div>
          </div>
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
