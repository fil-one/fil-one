import { KEY_NAME_MAX_LENGTH } from '@filone/shared';
import { useAccessKeyForm } from '../lib/use-access-key-form.js';
import { AccessKeyBucketScopeFields } from './AccessKeyBucketScopeFields.js';
import { AccessKeyExpirationFields } from './AccessKeyExpirationFields.js';
import { AccessKeyPermissionsFields } from './AccessKeyPermissionsFields.js';
import { Input } from './Input.js';

// Inverse of KEY_NAME_PATTERN's character class — finds disallowed chars
const INVALID_KEY_CHAR = /[^a-zA-Z0-9 _\-.]/g;

type AccessKeyFormFieldsProps = {
  form: ReturnType<typeof useAccessKeyForm>;
  pinnedBucket?: string;
};

export function AccessKeyFormFields({ form, pinnedBucket }: AccessKeyFormFieldsProps) {
  const {
    keyName,
    setKeyName,
    permissions,
    setPermissions,
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
        {invalidChars.length > 0 ? (
          <p className="text-xs text-red-600">
            Not allowed: {invalidChars.map((c) => `"${c}"`).join(', ')}
          </p>
        ) : overLimit ? (
          <p className="text-xs text-red-600">
            {keyName.length}/{KEY_NAME_MAX_LENGTH} characters — too long
          </p>
        ) : (
          <p className="text-xs text-zinc-500">
            A descriptive name helps identify this key in your list.
          </p>
        )}
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
        <p className="text-xs text-zinc-500">Restrict access to specific buckets or allow all</p>
        <AccessKeyBucketScopeFields
          bucketScope={bucketScope}
          onBucketScopeChange={setBucketScope}
          selectedBuckets={selectedBuckets}
          onSelectedBucketsChange={setSelectedBuckets}
          pinnedBucket={pinnedBucket}
        />
      </div>

      {/* Expiration */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-zinc-700">When should it expire?</label>
        <p className="text-xs text-zinc-500">Set an expiration date for added security</p>
        <AccessKeyExpirationFields
          value={expiration}
          customDate={customDate}
          onChange={setExpiration}
          onDateChange={setCustomDate}
        />
      </div>
    </div>
  );
}
