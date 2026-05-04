import { useState } from 'react';

import type {
  AccessKeyBucketScope,
  AccessKeyPermission,
  CreateAccessKeyResponse,
  GranularPermission,
} from '@filone/shared';
import { CreateAccessKeySchema, GRANULAR_PERMISSION_MAP } from '@filone/shared';
import { createAccessKey } from './api.js';
import { expiresAtFromForm } from './time.js';
import type { ExpirationOption } from '../components/AccessKeyExpirationFields.js';
import { useToast } from '../components/Toast/index.js';
import { useMutation } from '@tanstack/react-query';
import { queryClient, queryKeys } from './query-client.js';

export type UseAccessKeyFormOptions = {
  defaultBucket?: string;
  defaultPermissions?: AccessKeyPermission[];
  onSuccess: (response: CreateAccessKeyResponse) => void;
};

const FALLBACK_PERMISSIONS: AccessKeyPermission[] = ['read', 'write', 'list'];

export function useAccessKeyForm({
  defaultBucket,
  defaultPermissions,
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
  const [creating, setCreating] = useState(false);

  const candidatePayload = {
    keyName: keyName.trim(),
    permissions,
    granularPermissions: granularPermissions.length > 0 ? granularPermissions : undefined,
    bucketScope,
    buckets: bucketScope === 'specific' ? selectedBuckets : undefined,
    expiresAt: expiresAtFromForm(expiration, customDate),
  };
  const canSubmit = !creating && CreateAccessKeySchema.safeParse(candidatePayload).success;

  function handlePermissionsChange(newPermissions: AccessKeyPermission[]) {
    setPermissions(newPermissions);
    // Remove granular permissions that no longer belong to any selected basic permission
    const validGranular = new Set(newPermissions.flatMap((p) => GRANULAR_PERMISSION_MAP[p]));
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
    setCreating(false);
  }

  const createKeyMutation = useMutation({
    mutationFn: (body: {
      keyName: string;
      permissions: AccessKeyPermission[];
      granularPermissions?: GranularPermission[];
      bucketScope: AccessKeyBucketScope;
      buckets?: string[];
      expiresAt?: string | null;
    }) => {
      const parsed = CreateAccessKeySchema.safeParse(body);
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
    expiresAt: candidatePayload.expiresAt,
    creating,
    canSubmit,
    handleSubmit,
    reset,
  };
}
