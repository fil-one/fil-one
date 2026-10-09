import { useEffect, useRef, useState } from 'react';

import type {
  AccessKey,
  AccessKeyBucketScope,
  AccessKeyPermission,
  CreateAccessKeyRequest,
  CreateAccessKeyResponse,
  CreatePrincipalAccessKeyRequest,
  GranularPermission,
  S3Region,
} from '@filone/shared';
import {
  CreateAccessKeySchema,
  CreatePrincipalAccessKeySchema,
  GRANULAR_PERMISSION_MAP,
  isBucketPermission,
  isObjectPermission,
  supportsBucketManagement,
} from '@filone/shared';
import { isIamRegion } from './access-model.js';
import { createAccessKey } from './api.js';
import { expiresAtFromForm } from './time.js';
import type { ExpirationOption } from '../components/AccessKeyExpirationFields.js';
import { useToast } from '../components/Toast/index.js';
import { useMutation } from '@tanstack/react-query';
import { queryClient, queryKeys } from './query-client.js';

export type UseAccessKeyFormOptions = {
  defaultBucket?: string;
  defaultPermissions?: AccessKeyPermission[];
  region: S3Region;
  onSuccess: (response: CreateAccessKeyResponse) => void;
};

const FALLBACK_PERMISSIONS: AccessKeyPermission[] = [
  'read',
  'write',
  'list',
  'GetBucketVersioning',
  'GetBucketObjectLockConfiguration',
];

export function useAccessKeyForm({
  defaultBucket,
  defaultPermissions,
  region,
  onSuccess,
}: UseAccessKeyFormOptions) {
  const { toast } = useToast();

  const initialPermissions = defaultPermissions ?? FALLBACK_PERMISSIONS;

  const [keyName, setKeyName] = useState('');
  const [permissions, setPermissions] = useState<AccessKeyPermission[]>(initialPermissions);
  const [granularPermissions, setGranularPermissions] = useState<GranularPermission[]>([]);
  const [bucketScope, setBucketScope] = useState<AccessKeyBucketScope>(
    defaultBucket ? 'specific' : 'all',
  );
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>(
    defaultBucket ? [defaultBucket] : [],
  );
  const [expiration, setExpiration] = useState<ExpirationOption>('never');
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [chosenKeyType, setKeyType] = useState<AccessKey['type']>('principal');
  const [creating, setCreating] = useState(false);

  const prevRegionRef = useRef(region);
  useEffect(() => {
    if (prevRegionRef.current === region) return;
    prevRegionRef.current = region;
    setSelectedBuckets([]);
    // Drop bucket-management permissions when the new region can't support them.
    if (!supportsBucketManagement(region)) {
      setPermissions((prev) => prev.filter((p) => !isBucketPermission(p)));
    }
  }, [region]);

  // On an `iam` region a key is personal unless the caller chooses a service
  // key. Every other region takes only service keys.
  const isOnIamRegion = isIamRegion(region);
  const keyType = isOnIamRegion ? chosenKeyType : 'service';
  const expiresAt = expiresAtFromForm(expiration, customDate);
  const request = buildCreateKeyRequest(keyType, {
    keyName,
    permissions,
    granularPermissions,
    bucketScope,
    selectedBuckets,
    region,
    expiresAt,
  });
  const schema = keyType === 'principal' ? CreatePrincipalAccessKeySchema : CreateAccessKeySchema;
  const canSubmit = !creating && schema.safeParse(request).success;

  function handlePermissionsChange(newPermissions: AccessKeyPermission[]) {
    setPermissions(newPermissions);
    // Remove granulars that no longer belong to any selected object permission.
    const validGranular = new Set(
      newPermissions.filter(isObjectPermission).flatMap((p) => GRANULAR_PERMISSION_MAP[p]),
    );
    setGranularPermissions((prev) => prev.filter((g) => validGranular.has(g)));
  }

  function reset() {
    setKeyName('');
    setPermissions(initialPermissions);
    setGranularPermissions([]);
    setBucketScope(defaultBucket ? 'specific' : 'all');
    setSelectedBuckets(defaultBucket ? [defaultBucket] : []);
    setExpiration('never');
    setCustomDate(null);
    setKeyType('principal');
    setCreating(false);
  }

  const createKeyMutation = useMutation({
    mutationFn: (body: CreateAccessKeyRequest | CreatePrincipalAccessKeyRequest) => {
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0].message);
      }
      setCreating(true);
      return createAccessKey(body);
    },
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      setCreating(false);
      onSuccess(response);
    },
    onError: (err) => {
      setCreating(false);
      console.error('Failed to create access key:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to create access key');
    },
  });

  function handleSubmit(e?: { preventDefault(): void }) {
    e?.preventDefault();
    createKeyMutation.mutate(request);
  }

  return {
    keyName,
    setKeyName,
    permissions,
    setPermissions: handlePermissionsChange,
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
    expiresAt,
    isOnIamRegion,
    /** Always `'service'` outside an `iam` region. */
    keyType,
    setKeyType,
    /** The request as it would be sent, for a caller that submits it alongside another write. */
    request,
    /** The schema that validates `request`. */
    schema,
    creating,
    canSubmit,
    handleSubmit,
    reset,
  };
}

function buildCreateKeyRequest(
  keyType: AccessKey['type'],
  fields: {
    keyName: string;
    permissions: AccessKeyPermission[];
    granularPermissions: GranularPermission[];
    bucketScope: AccessKeyBucketScope;
    selectedBuckets: string[];
    region: S3Region;
    expiresAt: string | null;
  },
): CreateAccessKeyRequest | CreatePrincipalAccessKeyRequest {
  const keyName = fields.keyName.trim();
  const { region, expiresAt } = fields;
  if (keyType === 'principal') return { keyName, region, expiresAt };
  return {
    keyName,
    permissions: fields.permissions,
    granularPermissions:
      fields.granularPermissions.length > 0 ? fields.granularPermissions : undefined,
    bucketScope: fields.bucketScope,
    buckets: fields.bucketScope === 'specific' ? fields.selectedBuckets : undefined,
    region,
    expiresAt,
  };
}
