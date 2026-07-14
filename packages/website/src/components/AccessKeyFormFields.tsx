import type { S3Region } from '@filone/shared';
import { KEY_NAME_MAX_LENGTH } from '@filone/shared';
import { useAccessKeyForm } from '../lib/use-access-key-form.js';
import { AccessKeyBucketScopeFields } from './AccessKeyBucketScopeFields.js';
import { AccessKeyExpirationFields } from './AccessKeyExpirationFields.js';
import { AccessKeyPermissionsFields } from './AccessKeyPermissionsFields.js';
import { FormField } from './FormField.js';
import { Input } from './Input.js';
import { RegionSelect } from './RegionSelect.js';

// Inverse of KEY_NAME_PATTERN's character class — finds disallowed chars
const INVALID_KEY_CHAR = /[^a-zA-Z0-9 _\-.]/g;

type AccessKeyFormFieldsProps = {
  form: ReturnType<typeof useAccessKeyForm>;
  pinnedBucket?: string;
  region: S3Region;
  /** When provided, renders the region selector. Omit to hide it (caller owns the region). */
  onRegionChange?: (region: S3Region) => void;
};

export function AccessKeyFormFields({
  form,
  pinnedBucket,
  region,
  onRegionChange,
}: AccessKeyFormFieldsProps) {
  const {
    keyName,
    setKeyName,
    permissions,
    setPermissions,
    granularPermissions,
    setGranularPermissions,
    bucketScope,
    setBucketScope,
    selectedBuckets,
    setSelectedBuckets,
    expiration,
    setExpiration,
    customDate,
    setCustomDate,
  } = form;

  const invalidChars = [...new Set(keyName.match(INVALID_KEY_CHAR) ?? [])];
  const overLimit = keyName.length > KEY_NAME_MAX_LENGTH;

  return (
    <div className="flex flex-col gap-6">
      {/* Key name */}
      <FormField
        htmlFor="key-name"
        label="Key name"
        description="A descriptive name helps identify this key in your list."
        error={
          invalidChars.length > 0
            ? `Not allowed: ${invalidChars.map((c) => `"${c}"`).join(', ')}`
            : overLimit
              ? `${keyName.length}/${KEY_NAME_MAX_LENGTH} characters — too long`
              : undefined
        }
      >
        <Input
          id="key-name"
          value={keyName}
          invalid={invalidChars.length > 0 || overLimit}
          onChange={setKeyName}
          placeholder="e.g., Production API Key"
        />
      </FormField>

      {/* Region — only rendered when the caller supplies an onRegionChange handler */}
      {onRegionChange && (
        <FormField
          htmlFor="key-region"
          label="Region"
          description="This key only works with buckets in this region."
        >
          <RegionSelect id="key-region" value={region} onChange={onRegionChange} />
        </FormField>
      )}

      {/* Permissions */}
      <FormField
        label="What can this key do?"
        error={permissions.length === 0 ? 'Select at least one permission.' : undefined}
      >
        <AccessKeyPermissionsFields
          value={permissions}
          onChange={setPermissions}
          granularPermissions={granularPermissions}
          onGranularPermissionsChange={setGranularPermissions}
          region={region}
        />
      </FormField>

      {/* Bucket scope */}
      <FormField
        label="Which buckets can this key access?"
        description="Restrict access to specific buckets or allow all buckets in this region"
      >
        <AccessKeyBucketScopeFields
          bucketScope={bucketScope}
          onBucketScopeChange={setBucketScope}
          selectedBuckets={selectedBuckets}
          onSelectedBucketsChange={setSelectedBuckets}
          pinnedBucket={pinnedBucket}
          region={region}
        />
      </FormField>

      {/* Expiration */}
      <FormField
        label="When should it expire?"
        description="Set an expiration date for added security"
      >
        <AccessKeyExpirationFields
          value={expiration}
          customDate={customDate}
          onChange={setExpiration}
          onDateChange={setCustomDate}
        />
      </FormField>
    </div>
  );
}
