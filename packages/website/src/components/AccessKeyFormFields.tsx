import type { S3Region } from '@filone/shared';
import { KEY_NAME_MAX_LENGTH, RESERVED_KEY_NAME_PREFIX, isReservedKeyName } from '@filone/shared';
import { useAccessKeyForm } from '../lib/use-access-key-form.js';
import { useHasPermission } from '../lib/use-permissions.js';
import { AccessKeyBucketScopeFields } from './AccessKeyBucketScopeFields.js';
import { AccessKeyExpirationFields } from './AccessKeyExpirationFields.js';
import { AccessKeyPermissionsFields } from './AccessKeyPermissionsFields.js';
import { Alert } from './Alert.js';
import { FormField } from './FormField.js';
import { Input } from './Input.js';
import { RadioOption } from './RadioOption.js';
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

  // A service key answers to no bucket policy, so only a role holding this may
  // mint one on a region that has them.
  const mayMintServiceKey = useHasPermission('keys.create_service');
  const invalidChars = [...new Set(keyName.match(INVALID_KEY_CHAR) ?? [])];
  const overLimit = keyName.length > KEY_NAME_MAX_LENGTH;
  const reservedName = isReservedKeyName(keyName);

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
              : reservedName
                ? `Names starting with "${RESERVED_KEY_NAME_PREFIX}" are reserved for FilOne.`
                : undefined
        }
      >
        <Input
          id="key-name"
          value={keyName}
          invalid={invalidChars.length > 0 || overLimit || reservedName}
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

      {/* On an `iam` region the key belongs to the caller by default and
          carries nothing of its own. An Owner or Admin may instead mint a
          service key, which carries its own permissions and bucket list. */}
      {form.iam && mayMintServiceKey && (
        <FormField label="What kind of key?">
          <div className="flex gap-2">
            <RadioOption
              name="key-kind"
              value="principal"
              checked={!form.serviceKey}
              onChange={() => form.setServiceKey(false)}
              description="Acts as you. Each bucket's policy decides what it can reach."
            >
              Personal key
            </RadioOption>
            <RadioOption
              name="key-kind"
              value="service"
              checked={form.serviceKey}
              onChange={() => form.setServiceKey(true)}
              description="Carries its own permissions and buckets. Bucket policies do not apply."
            >
              Service key
            </RadioOption>
          </div>
        </FormField>
      )}

      {form.principal ? (
        <Alert
          variant="blue"
          assertive={false}
          description="This key acts as you. What it can reach is decided by each bucket's policy."
        />
      ) : (
        <>
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
        </>
      )}

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
