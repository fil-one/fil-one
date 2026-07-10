import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import type { CreateRagApiKeyResponse, RagApiKey, RagKeyBucketRef } from '@filone/shared';
import { KEY_NAME_MAX_LENGTH, KEY_NAME_PATTERN } from '@filone/shared';

import { Alert } from '../components/Alert.js';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { Checkbox } from '../components/Checkbox.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { CopyButton } from '../components/CopyButton.js';
import { Heading } from '../components/Heading/Heading.js';
import { IconBox } from '../components/IconBox.js';
import { IconButton } from '../components/IconButton.js';
import { Input } from '../components/Input.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/Modal/index.js';
import { RadioOption } from '../components/RadioOption.js';
import { Table } from '../components/Table/Table.js';
import { useToast } from '../components/Toast/index.js';
import { createRagApiKey, deleteRagApiKey, listRagApiKeys } from '../lib/rag-api-keys-api.js';
import { bucketKey, type RagBucket } from '../lib/rag-bucket-api.js';
import { queryKeys } from '../lib/query-client.js';
import { formatDate } from '../lib/time.js';

// ---------------------------------------------------------------------------
// Scope rendering
// ---------------------------------------------------------------------------

function ScopeCell({ apiKey }: { apiKey: RagApiKey }) {
  if (apiKey.bucketScope === 'all') {
    return (
      <Badge color="grey" size="sm" strength="subtle">
        All buckets
      </Badge>
    );
  }
  const buckets = apiKey.buckets ?? [];
  const shown = buckets.slice(0, 2);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((b) => (
        <Badge key={`${b.region}:${b.name}`} color="blue" size="sm" strength="subtle">
          {b.name}
        </Badge>
      ))}
      {buckets.length > shown.length && (
        <span className="text-xs text-zinc-500">+{buckets.length - shown.length} more</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create key modal
// ---------------------------------------------------------------------------

function CreateRagKeyModal({
  open,
  onClose,
  onCreated,
  buckets,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (created: CreateRagApiKeyResponse) => void;
  buckets: RagBucket[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [keyName, setKeyName] = useState('');
  const [bucketScope, setBucketScope] = useState<'all' | 'specific'>('all');
  const [selected, setSelected] = useState<string[]>([]);

  // Scope entries must be (region, name) pairs — bucket names are only
  // region-scoped, so a bare name could match another region's bucket.
  const selectableBuckets = buckets.filter((b) => b.enabled);

  const nameValid =
    keyName.trim().length > 0 &&
    keyName.trim().length <= KEY_NAME_MAX_LENGTH &&
    KEY_NAME_PATTERN.test(keyName.trim());
  const canSubmit = nameValid && (bucketScope === 'all' || selected.length > 0);

  const createMutation = useMutation({
    mutationFn: () => {
      const scopedBuckets: RagKeyBucketRef[] = selectableBuckets
        .filter((b) => selected.includes(bucketKey(b)))
        .map((b) => ({ region: b.region, name: b.name }));
      return createRagApiKey({
        keyName: keyName.trim(),
        bucketScope,
        ...(bucketScope === 'specific' ? { buckets: scopedBuckets } : {}),
      });
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ragApiKeys });
      setKeyName('');
      setBucketScope('all');
      setSelected([]);
      onCreated(created);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to create API key');
    },
  });

  function toggleBucket(key: string) {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  return (
    <Modal open={open} onClose={onClose} size="md" testId="create-rag-key-modal">
      <ModalHeader
        description="The key authorizes the Query API only — it cannot read or write bucket contents."
        onClose={onClose}
      >
        Create API key
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="rag-key-name" className="text-sm font-medium text-zinc-900">
              Key name
            </label>
            <Input
              id="rag-key-name"
              placeholder="e.g. Support agent"
              value={keyName}
              onChange={setKeyName}
              invalid={keyName.length > 0 && !nameValid}
              maxLength={KEY_NAME_MAX_LENGTH}
            />
            {keyName.length > 0 && !nameValid && (
              <p className="text-xs text-red-600">
                Key name can only contain letters, numbers, spaces, hyphens, underscores, and
                periods
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-zinc-900">Which buckets can this key query?</p>
            <div className="flex gap-2">
              {(['all', 'specific'] as const).map((scope) => (
                <RadioOption
                  key={scope}
                  name="rag-key-bucket-scope"
                  value={scope}
                  checked={bucketScope === scope}
                  onChange={() => setBucketScope(scope)}
                >
                  {scope === 'all' ? 'All buckets' : 'Specific buckets'}
                </RadioOption>
              ))}
            </div>

            {bucketScope === 'specific' && (
              <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
                {selectableBuckets.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    No RAG-enabled buckets yet. Enable RAG on a bucket in the Buckets tab first.
                  </p>
                ) : (
                  <div className="flex flex-col space-y-1.5">
                    {selectableBuckets.map((b) => {
                      const key = bucketKey(b);
                      return (
                        <label key={key} className="flex cursor-pointer items-center gap-2.5 py-1">
                          <Checkbox
                            aria-label={b.name}
                            checked={selected.includes(key)}
                            onChange={() => toggleBucket(key)}
                          />
                          <span className="text-xs font-normal text-zinc-900">{b.name}</span>
                          <Badge color="grey" size="sm" strength="subtle">
                            {b.region}
                          </Badge>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={createMutation.isPending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!canSubmit || createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          Create key
        </Button>
      </ModalFooter>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Shown-once token modal
// ---------------------------------------------------------------------------

function RagKeyCreatedModal({
  createdKey,
  onDone,
}: {
  createdKey: CreateRagApiKeyResponse;
  onDone: () => void;
}) {
  const [showToken, setShowToken] = useState(false);

  return (
    <Modal open onClose={onDone} size="md" testId="rag-key-created-modal">
      <ModalHeader onClose={onDone}>Save your API key</ModalHeader>
      <ModalBody>
        <div className="mb-4">
          <Alert
            variant="amber"
            description="This is the only time the key will be shown. Store it somewhere safe — you will not be able to view it again."
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-(--color-text-base)">{createdKey.keyName}</p>
          <div className="flex items-center gap-2">
            <div className="flex h-9 flex-1 items-center overflow-hidden rounded-md border border-(--input-border-color) bg-zinc-50 px-3">
              <span
                data-testid="rag-key-token"
                className="truncate font-mono text-xs text-(--color-text-base)"
              >
                {showToken ? createdKey.token : '•'.repeat(40)}
              </span>
            </div>
            <IconButton
              icon={showToken ? EyeSlashIcon : EyeIcon}
              aria-label={showToken ? 'Hide API key' : 'Show API key'}
              onClick={() => setShowToken((s) => !s)}
            />
            <CopyButton size="md" value={createdKey.token} />
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onDone}>
          I've saved this key
        </Button>
      </ModalFooter>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// RagApiKeysTab
// ---------------------------------------------------------------------------

export function RagApiKeysTab({ buckets }: { buckets: RagBucket[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreateRagApiKeyResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RagApiKey | null>(null);

  const { data, isPending, isError, error } = useQuery({
    queryKey: queryKeys.ragApiKeys,
    queryFn: () => listRagApiKeys(),
  });
  const keys = data?.keys ?? [];

  const deleteMutation = useMutation({
    mutationFn: (keyId: string) => deleteRagApiKey(keyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ragApiKeys });
      toast.success('API key deleted');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete API key');
    },
  });

  return (
    <div data-testid="rag-api-keys-tab" className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <Heading
          tag="h2"
          size="lg"
          description="Bearer tokens for the Query API. Not to be confused with S3 access keys — these cannot read or write bucket contents."
        >
          API Keys
        </Heading>
        <Button
          variant="primary"
          icon={PlusIcon}
          className="mt-1 flex-shrink-0"
          onClick={() => setCreateOpen(true)}
        >
          Create API key
        </Button>
      </div>

      {isError && (
        <Alert
          variant="red"
          description={error instanceof Error ? error.message : 'Failed to load API keys'}
        />
      )}

      {!isPending && !isError && keys.length === 0 && (
        <div
          data-testid="rag-api-keys-empty"
          className="flex flex-col items-center gap-3 rounded-xl border border-zinc-200 bg-white px-6 py-12 text-center"
        >
          <IconBox icon={KeyIcon} color="grey" size="lg" />
          <div>
            <p className="text-sm font-medium text-zinc-900">No API keys yet</p>
            <p className="mt-1 text-xs text-zinc-500">
              Create a key to query your RAG-enabled buckets from your app or agent.
            </p>
          </div>
        </div>
      )}

      {!isPending && !isError && keys.length > 0 && (
        <Table data-testid="rag-api-keys-table">
          <Table.Header>
            <Table.Row>
              <Table.Head>Name</Table.Head>
              <Table.Head>Key</Table.Head>
              <Table.Head>Scope</Table.Head>
              <Table.Head>Created</Table.Head>
              <Table.Head>Last used</Table.Head>
              <Table.Head aria-label="Actions" />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {keys.map((k) => (
              <Table.Row key={k.id}>
                <Table.Cell className="text-sm font-medium text-zinc-900">{k.keyName}</Table.Cell>
                <Table.Cell>
                  <span className="font-mono text-xs text-zinc-600">{k.keyPrefix}…</span>
                </Table.Cell>
                <Table.Cell>
                  <ScopeCell apiKey={k} />
                </Table.Cell>
                <Table.Cell className="text-sm text-zinc-500">{formatDate(k.createdAt)}</Table.Cell>
                <Table.Cell className="text-sm text-zinc-500">
                  {k.lastUsedAt ? formatDate(k.lastUsedAt) : 'Never'}
                </Table.Cell>
                <Table.Cell className="text-right">
                  <IconButton
                    icon={TrashIcon}
                    aria-label={`Delete API key ${k.keyName}`}
                    onClick={() => setDeleteTarget(k)}
                  />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      <CreateRagKeyModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => {
          setCreateOpen(false);
          setCreatedKey(created);
        }}
        buckets={buckets}
      />

      {createdKey && (
        <RagKeyCreatedModal createdKey={createdKey} onDone={() => setCreatedKey(null)} />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) await deleteMutation.mutateAsync(deleteTarget.id);
        }}
        title={`Delete "${deleteTarget?.keyName}"?`}
        description="Any application using this key will immediately lose access. This cannot be undone."
        confirmLabel="Delete key"
      />
    </div>
  );
}
