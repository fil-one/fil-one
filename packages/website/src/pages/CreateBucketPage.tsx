import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, CaretRightIcon } from '@phosphor-icons/react/dist/ssr';

import { S3_REGION, CreateBucketSchema } from '@filone/shared';
import type {
  CreateBucketResponse,
  RetentionMode,
  RetentionDurationType,
  S3Region,
} from '@filone/shared';
import { apiRequest, errorStatusOf } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';

import { Heading } from '../components/Heading/Heading';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { FormField } from '../components/FormField';
import { Overline } from '../components/Overline';
import { Input } from '../components/Input';
import { RegionSelect } from '../components/RegionSelect';
import { useAvailableRegions } from '../lib/use-available-regions.js';
import { ObjectSettingsFields } from '../components/ObjectSettingsFields';
import { SlowOperationIndicator } from '../components/SlowOperationIndicator';
import { useToast } from '../components/Toast';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The line beside the collapsed Advanced settings toggle: what is inside, or what is on. */
function getAdvancedSettingsSummary(settings: {
  versioning: boolean;
  lock: boolean;
  retentionEnabled: boolean;
}): string {
  const enabled = [
    settings.versioning && 'Versioning',
    settings.lock && 'Object Lock',
    settings.retentionEnabled && 'Retention',
  ].filter((name) => name !== false);
  if (enabled.length === 0) return 'Versioning, Object Lock, Retention';
  return `${new Intl.ListFormat('en', { type: 'conjunction' }).format(enabled)} on`;
}

/** The create request's body, with retention included only when it is turned on. */
function buildCreateBucketBody(fields: {
  bucketName: string;
  region: S3Region;
  versioning: boolean;
  lock: boolean;
  retention?: { mode: RetentionMode; duration: number; durationType: RetentionDurationType };
}) {
  const { retention, ...bucket } = fields;
  return {
    ...bucket,
    bucketName: bucket.bucketName.trim(),
    ...(retention && { retention: { enabled: true as const, ...retention } }),
  };
}

const TAKEN_NAME_MESSAGE = 'This name is already taken. Try another.';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// eslint-disable-next-line max-lines-per-function
export function CreateBucketPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const availableRegions = useAvailableRegions();

  // Bucket fields
  const [bucketName, setBucketName] = useState('');
  const [region, setRegion] = useState<S3Region>(S3_REGION);

  // Object settings, collapsed under Advanced settings because the defaults suit most buckets
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [versioning, setVersioning] = useState(false);
  const [lock, setLock] = useState(false);
  const [retentionEnabled, setRetentionEnabled] = useState(false);
  const [retentionMode, setRetentionMode] = useState<RetentionMode>('governance');
  const [retentionDuration, setRetentionDuration] = useState(15);
  const [retentionDurationType, setRetentionDurationType] = useState<RetentionDurationType>('d');

  // Validation
  const [bucketNameError, setBucketNameError] = useState<string | null>(null);
  // The name the server last refused as taken, and where: names are unique within a region,
  // so the same name may be free in another. The local format check accepts a taken name,
  // so without this a blur or an edit back to it would clear the refusal.
  const [takenBucket, setTakenBucket] = useState<{ name: string; region: S3Region } | null>(null);

  // Submit state
  const [creating, setCreating] = useState(false);
  const bucketNameRef = useRef<HTMLElement>(null);

  function isTakenName(value: string, forRegion: S3Region = region) {
    return value.trim() === takenBucket?.name && forRegion === takenBucket.region;
  }

  function validateBucketName(value: string, forRegion: S3Region = region) {
    if (isTakenName(value, forRegion)) {
      setBucketNameError(TAKEN_NAME_MESSAGE);
      return false;
    }
    const result = CreateBucketSchema.shape.bucketName.safeParse(value);
    if (!result.success) {
      setBucketNameError(result.error.issues[0].message);
      return false;
    }
    setBucketNameError(null);
    return true;
  }

  /**
   * A name taken in one region may be free in the next, so a shown error is checked again,
   * and a return to the region that refused the name brings the refusal back.
   */
  function handleRegionChange(next: S3Region) {
    setRegion(next);
    if (bucketNameError || isTakenName(bucketName, next)) validateBucketName(bucketName, next);
  }

  /** Says what is wrong with the name under the field, and puts the cursor back in it. */
  function refuseName(message: string) {
    setBucketNameError(message);
    bucketNameRef.current?.focus();
  }

  function reportCreateFailure(err: unknown) {
    // This route answers 409 only for a name someone already holds, and the fix is in the name field
    if (errorStatusOf(err) === 409) {
      setTakenBucket({ name: bucketName.trim(), region });
      return refuseName(TAKEN_NAME_MESSAGE);
    }
    toast.error(err instanceof Error ? err.message : 'Failed to create bucket');
  }

  async function handleSubmit() {
    // The button stays enabled on an empty form, so the refusal is said where the name goes
    if (!bucketName.trim()) return refuseName('Enter a bucket name.');

    const parsed = CreateBucketSchema.safeParse(
      buildCreateBucketBody({
        bucketName,
        region,
        versioning,
        lock,
        retention: retentionEnabled
          ? {
              mode: retentionMode,
              duration: retentionDuration,
              durationType: retentionDurationType,
            }
          : undefined,
      }),
    );
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      // A name the schema refuses is said under the field; anything else, as a toast
      if (issue.path[0] === 'bucketName') return refuseName(issue.message);
      return toast.error(issue.message);
    }

    setCreating(true);
    let createdBucketName: string;
    try {
      const { bucket } = await apiRequest<CreateBucketResponse>('/buckets', {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      createdBucketName = bucket.bucketName;
      void queryClient.invalidateQueries({ queryKey: queryKeys.buckets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
    } catch (err) {
      reportCreateFailure(err);
      setCreating(false);
      return;
    }

    toast.success('Bucket created successfully');
    setCreating(false);
    // The new bucket opens on its empty state, which offers the API key as the next step
    void navigate({
      to: '/buckets/$bucketName',
      params: { bucketName: createdBucketName },
      search: { region },
    });
  }

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-6 px-5 pt-6 pb-12 sm:px-8 lg:px-10 lg:pt-12 xl:px-0">
      {/* Back + header */}
      {/* The title starts on the card's edge at every width. With room beside the page the arrow
          hangs in the margin on the title's line; without it, the arrow takes its own row above,
          pulled left by the button's padding so the icon itself sits on that edge. */}
      <div className="relative flex flex-col items-start gap-2 xl:block">
        <div className="-ml-1.5 flex h-7 items-center xl:absolute xl:top-0 xl:right-full xl:mr-4 xl:ml-0">
          <IconButton
            icon={ArrowLeftIcon}
            aria-label="Back to buckets"
            onClick={() => navigate({ to: '/buckets' })}
          />
        </div>
        <Heading tag="h1" description="A bucket is a container for your files.">
          Create bucket
        </Heading>
      </div>

      {/* Two columns once both fit beside the app sidebar; stacked below that */}
      <div className="flex flex-col gap-6 xl:flex-row xl:gap-10">
        {/* Left: White card with form */}
        <Card className="w-full max-w-[520px] shrink-0 overflow-hidden">
          <div className="flex flex-col gap-5">
            {/* Bucket name */}
            <FormField
              htmlFor="bucket-name"
              label="Bucket name"
              description="3-63 lowercase letters, numbers, or hyphens. Must be unique in this region."
              error={bucketNameError ?? undefined}
            >
              <Input
                id="bucket-name"
                ref={bucketNameRef}
                value={bucketName}
                invalid={!!bucketNameError}
                onChange={(v) => {
                  setBucketName(v);
                  // Re-checked while an error shows, and on typing back to a taken name
                  if (bucketNameError || isTakenName(v)) validateBucketName(v);
                }}
                onBlur={() => {
                  if (bucketName.trim()) validateBucketName(bucketName);
                }}
                placeholder="my-storage-bucket"
                autoComplete="off"
                inputSize="lg"
                // Fixed while the request is out, so a refusal that comes back names the name sent
                readOnly={creating}
              />
            </FormField>

            {/* Region */}
            <FormField
              htmlFor="bucket-region"
              label="Region"
              description={availableRegions.length === 1 ? 'More regions coming soon.' : undefined}
            >
              <RegionSelect
                id="bucket-region"
                value={region}
                onChange={handleRegionChange}
                size="lg"
                // The page opens the new bucket in this region once the request answers
                disabled={creating}
              />
            </FormField>

            {/* Advanced settings */}
            <div className="flex flex-col gap-3">
              <button
                type="button"
                id="create-bucket-toggle-advanced"
                aria-expanded={advancedOpen}
                aria-controls="create-bucket-advanced-settings"
                onClick={() => setAdvancedOpen(!advancedOpen)}
                className="group flex w-full items-center gap-1.5 rounded-md text-left focus-visible:brand-outline"
              >
                <CaretRightIcon
                  size={12}
                  aria-hidden="true"
                  className="shrink-0 text-zinc-500 transition-transform duration-150 group-hover:text-zinc-900 group-aria-expanded:rotate-90 motion-reduce:transition-none"
                />
                <span className="shrink-0 text-xs font-medium text-zinc-900">
                  Advanced settings
                </span>
                {/* Only while closed: once open, the switches it summarises are right below */}
                <span className="ml-auto min-w-0 truncate pl-3 text-meta text-zinc-500 group-aria-expanded:hidden">
                  {getAdvancedSettingsSummary({ versioning, lock, retentionEnabled })}
                </span>
              </button>

              {advancedOpen && (
                <div id="create-bucket-advanced-settings">
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
                </div>
              )}
            </div>

            {/* Submit button */}
            <Button
              id="create-bucket-submit-button"
              variant="primary"
              size="lg"
              disabled={creating}
              onClick={handleSubmit}
            >
              {creating ? 'Creating...' : 'Create bucket'}
            </Button>
            <SlowOperationIndicator isLoading={creating} operation="Creating bucket" />
          </div>
        </Card>

        {/* Right: Info sidebar */}
        {/* pt-5 lines the overline up with the card's first label, which sits under the card's p-5 */}
        <div className="w-full max-w-[520px] xl:sticky xl:top-0 xl:w-60 xl:shrink-0 xl:self-start xl:pt-5">
          <Overline>Included by default</Overline>

          <div className="mt-3 flex flex-col">
            {/* Encryption */}
            <div className="flex flex-col gap-0.5 py-3">
              <span className="text-xs font-medium text-zinc-900">Encryption</span>
              <p className="text-xs leading-relaxed text-zinc-500">
                All data is encrypted at rest.
              </p>
            </div>

            {/* Private */}
            <div className="flex flex-col gap-0.5 border-t border-zinc-200/60 py-3">
              <span className="text-xs font-medium text-zinc-900">Private</span>
              <p className="text-xs leading-relaxed text-zinc-500">
                All buckets are private. Access requires an API key.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
