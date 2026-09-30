import { useEffect, useRef, useState } from 'react';

import type {
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
  const [serviceKey, setServiceKey] = useState(false);
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

  // On a region serving the `iam` access model the key belongs to the caller's
  // principal by default and carries no permission set or bucket list of its
  // own, so the request is a name and an expiry and the schema is the
  // principal-bound one. A caller who chooses a service key instead sends the
  // scoped-key shape, which every region takes.
  const iam = isIamRegion(region);
  const principal = iam && !serviceKey;
  const expiresAt = expiresAtFromForm(expiration, customDate);
  const candidatePayload = buildPayload(principal, {
    keyName,
    permissions,
    granularPermissions,
    bucketScope,
    selectedBuckets,
    region,
    expiresAt,
  });
  const schema = principal ? CreatePrincipalAccessKeySchema : CreateAccessKeySchema;
  const canSubmit = !creating && schema.safeParse(candidatePayload).success;

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
    setServiceKey(false);
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
    createKeyMutation.mutate(candidatePayload);
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
    /** Whether the region serves the `iam` access model, where a key is bound to the caller unless it is a service key. */
    iam,
    /** Whether the request is for a key bound to the caller, which takes no permissions or bucket scope. */
    principal,
    /** On an `iam` region, whether the caller chose a service key over one bound to them. */
    serviceKey,
    setServiceKey,
    /** The request as it would be sent, for a caller that submits it alongside another write. */
    payload: candidatePayload,
    creating,
    canSubmit,
    handleSubmit,
    reset,
  };
}

/** The request the form's state amounts to, in the shape the region's model takes. */
function buildPayload(
  principal: boolean,
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
  if (principal) return { keyName, region, expiresAt };
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
