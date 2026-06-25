import { useEffect, useRef, useState } from 'react';

import type {
  AccessKeyBucketScope,
  CreateAccessKeyResponse,
  AccessKeyPermission,
  S3Region,
} from '@filone/shared';
import { CreateAccessKeySchema, DEFAULT_ACCESS_KEY_PERMISSIONS } from '@filone/shared';
import { createAccessKey } from './api.js';
import { expiresAtFromForm } from './time.js';
import type { ExpirationOption } from '../components/AccessKeyExpirationFields.js';
import { useToast } from '../components/Toast/index.js';
import { useMutation } from '@tanstack/react-query';
import { queryClient, queryKeys } from './query-client.js';

export type UseAccessKeyFormOptions = {
  defaultBucket?: string;
  defaultAccessKeyPermissions?: AccessKeyPermission[];
  region: S3Region;
  onSuccess: (response: CreateAccessKeyResponse) => void;
};

export function useAccessKeyForm({
  defaultBucket,
  defaultAccessKeyPermissions,
  region,
  onSuccess,
}: UseAccessKeyFormOptions) {
  const { toast } = useToast();

  const initialAccessKeyPermissions = defaultAccessKeyPermissions ?? DEFAULT_ACCESS_KEY_PERMISSIONS;

  const [keyName, setKeyName] = useState('');
  const [permissions, setPermissions] = useState<AccessKeyPermission[]>(
    initialAccessKeyPermissions,
  );
  const [bucketScope, setBucketScope] = useState<AccessKeyBucketScope>(
    defaultBucket ? 'specific' : 'all',
  );
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>(
    defaultBucket ? [defaultBucket] : [],
  );
  const [expiration, setExpiration] = useState<ExpirationOption>('never');
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const prevRegionRef = useRef(region);
  useEffect(() => {
    if (prevRegionRef.current === region) return;
    prevRegionRef.current = region;
    setSelectedBuckets([]);
  }, [region]);

  const candidatePayload = {
    keyName: keyName.trim(),
    permissions,
    bucketScope,
    buckets: bucketScope === 'specific' ? selectedBuckets : undefined,
    region,
    expiresAt: expiresAtFromForm(expiration, customDate),
  };
  const canSubmit =
    !creating &&
    permissions.length > 0 &&
    CreateAccessKeySchema.safeParse(candidatePayload).success;

  function reset() {
    setKeyName('');
    setPermissions(initialAccessKeyPermissions);
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
      bucketScope: AccessKeyBucketScope;
      buckets?: string[];
      region: S3Region;
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
    setPermissions,
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
