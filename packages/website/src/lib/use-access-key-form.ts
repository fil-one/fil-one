import { useState } from 'react';

import type {
  AccessKeyBucketScope,
  AccessKeyPermission,
  CreateAccessKeyResponse,
} from '@filone/shared';
import { CreateAccessKeySchema, KEY_NAME_MAX_LENGTH } from '@filone/shared';
import { createAccessKey } from './api.js';
import { expiresAtFromForm } from './time.js';
import type { ExpirationOption } from '../components/AccessKeyExpirationFields.js';
import { useToast } from '../components/Toast/index.js';
import { useMutation } from '@tanstack/react-query';
import { queryClient, queryKeys } from './query-client.js';

export type UseAccessKeyFormOptions = {
  defaultBucket?: string;
  onSuccess: (response: CreateAccessKeyResponse) => void;
};

export function useAccessKeyForm({ defaultBucket, onSuccess }: UseAccessKeyFormOptions) {
  const { toast } = useToast();

  const [keyName, setKeyName] = useState('');
  const [permissions, setPermissions] = useState<AccessKeyPermission[]>(['read', 'write', 'list']);
  const [bucketScope, setBucketScope] = useState<AccessKeyBucketScope>(
    defaultBucket ? 'specific' : 'all',
  );
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>(
    defaultBucket ? [defaultBucket] : [],
  );
  const [expiration, setExpiration] = useState<ExpirationOption>('never');
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const bucketsValid = bucketScope === 'all' || selectedBuckets.length > 0;
  const canSubmit =
    keyName.trim().length > 0 &&
    keyName.trim().length <= KEY_NAME_MAX_LENGTH &&
    permissions.length > 0 &&
    bucketsValid &&
    !creating;

  function reset() {
    setKeyName('');
    setPermissions(['read', 'write', 'list']);
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
    if (!keyName.trim() || permissions.length === 0) return;
    createKeyMutation.mutate({
      keyName: keyName.trim(),
      permissions,
      bucketScope,
      buckets: bucketScope === 'specific' ? selectedBuckets : undefined,
      expiresAt: expiresAtFromForm(expiration, customDate),
    });
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
    expiresAt: expiresAtFromForm(expiration, customDate),
    creating,
    canSubmit,
    handleSubmit,
    reset,
  };
}
