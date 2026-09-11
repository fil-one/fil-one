import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  DownloadSimpleIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import type {
  CreateRagApiKeyResponse,
  ListRagApiKeysResponse,
  RagApiKey,
  RagKeyBucketRef,
} from '@filone/shared';
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
import { SplitButton } from '../components/SplitButton.js';
import { Table } from '../components/Table/Table.js';
import { useToast } from '../components/Toast/index.js';
import { createRagApiKey, deleteRagApiKey, listRagApiKeys } from '../lib/rag-api-keys-api.js';
import { bucketKey, type RagBucket } from '../lib/rag-bucket-api.js';
import { queryKeys } from '../lib/query-client.js';
import { useHasPermission } from '../lib/use-permissions.js';
import { useKeyActionScope } from '../lib/use-key-scope.js';
import { usePermittedDialog } from '../lib/use-permitted-dialog.js';
import { ApiReference } from './RagPipelineTabs.js';
import { formatDate } from '../lib/time.js';
import { downloadText } from '../lib/download.js';

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
        description="Authorizes the Query API only. It cannot read or write bucket contents."
        onClose={onClose}
      >
        Create API key
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col divide-y divide-zinc-100">
          <div className="flex flex-col gap-1.5 pb-4">
            <label htmlFor="rag-key-name" className="text-xs font-medium text-zinc-500">
              Name
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

          <div className="flex flex-col gap-2 pt-4">
            {/* "All buckets" / "Specific buckets" explain themselves, so the
                helper sentence that was here was pure restatement. */}
            <p className="text-xs font-medium text-zinc-500">Scope</p>
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
                    No indexed buckets yet. Index a bucket in the Buckets tab first.
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
      <ModalFooter fullWidth>
        <Button variant="ghost" size="md" onClick={onClose} disabled={createMutation.isPending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
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

  // .env leads because the Query API sample and the reference copy both read the
  // key from $FILONE_RAG_KEY, so this file drops straight in.
  function handleDownloadEnv() {
    downloadText(`FILONE_RAG_KEY=${createdKey.token}\n`, 'filone-rag-key.env', 'text/plain');
  }

  function handleDownloadCsv() {
    const csv = ['Key name,API key', `${createdKey.keyName},${createdKey.token}`].join('\n');
    downloadText(csv, 'filone-rag-key.csv', 'text/csv');
  }

  return (
    <Modal open onClose={onDone} size="md" testId="rag-key-created-modal">
      <ModalHeader onClose={onDone}>Save your API key</ModalHeader>
      <ModalBody>
        <div className="mb-4">
          {/* Title only, at the larger of the two type sizes Alert offers: the
              consequence of closing without saving is the whole message, and
              splitting it across title and description made two lines out of one
              idea. */}
          <Alert variant="amber" title="Shown once only. Save your key somewhere safe." />
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
      <ModalFooter fullWidth>
        <Button variant="ghost" onClick={onDone}>
          I've saved this key
        </Button>
        <SplitButton
          label="Download .env"
          icon={DownloadSimpleIcon}
          onMainClick={handleDownloadEnv}
          items={[{ label: 'Download .csv', icon: DownloadSimpleIcon, onClick: handleDownloadCsv }]}
        />
      </ModalFooter>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Keys table
// ---------------------------------------------------------------------------

function RagKeysTable({
  keys,
  showActions,
  mayRevoke,
  onRequestDelete,
}: {
  keys: RagApiKey[];
  /** Whether any row carries the action — the header follows the cells. */
  showActions: boolean;
  mayRevoke: (key: RagApiKey) => boolean;
  onRequestDelete: (key: RagApiKey) => void;
}) {
  return (
    <Table data-testid="rag-api-keys-table">
      <Table.Header>
        <Table.Row>
          <Table.Head>Name</Table.Head>
          {/* "Key" implied this was the key, truncated, which contradicts the
              shown-once warning at creation. It is a 12-char display prefix
              (RAG_KEY_DISPLAY_PREFIX_LENGTH), of which only 5 characters are
              the secret; the backend keeps a SHA-256 hash and never the token. */}
          <Table.Head>Prefix</Table.Head>
          <Table.Head>Scope</Table.Head>
          <Table.Head>Created</Table.Head>
          <Table.Head>Last used</Table.Head>
          {/* Same predicate as the cells below: a column of empty cells is
              whitespace with a screen-reader label attached to nothing. */}
          {showActions && <Table.Head aria-label="Actions" />}
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
            {showActions && (
              <Table.Cell className="text-right">
                {mayRevoke(k) && (
                  <IconButton
                    icon={TrashIcon}
                    aria-label={`Delete API key ${k.keyName}`}
                    onClick={() => onRequestDelete(k)}
                  />
                )}
              </Table.Cell>
            )}
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// RagApiKeysTab
// ---------------------------------------------------------------------------

/**
 * The keys to render, read through the permission that gated the fetch.
 *
 * react-query keeps serving a disabled query's cached answer, and a mounted tab
 * is a live observer so nothing collects it. Gating only `enabled` leaves the
 * names, prefixes and scopes on screen after a mid-session downgrade; reading
 * through `mayList` makes them go with the permission.
 */
function visibleKeys(mayList: boolean, data: ListRagApiKeysResponse | undefined): RagApiKey[] {
  return mayList ? (data?.keys ?? []) : [];
}

/**
 * The delete confirmation's gate, as a value the component can hand the dialog
 * hook: the same per-key rule the row's own Delete button reads. It lives out
 * here so the tab keeps one nested closure fewer.
 */
function revocable(mayRevoke: (key: RagApiKey) => boolean) {
  return (key: RagApiKey | null) => key === null || mayRevoke(key);
}

export function RagApiKeysTab({ buckets }: { buckets: RagBucket[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mayCreate = useHasPermission('keys.create');
  // Listing is `keys.manage_own`, and the server returns only the caller's own
  // keys unless they hold `keys.manage_all`. ReadOnly holds neither, so the
  // request is not made rather than made and refused.
  const { mayList, mayRevoke, mayRevokeAny } = useKeyActionScope();

  // Both dialogs go with the controls that open them: Create with
  // `keys.create`, Delete with the same per-key revoke rule as the row's own
  // button, which a demotion to `keys.manage_own` narrows to the caller's keys.
  const [createOpen, setCreateOpen] = usePermittedDialog(false, mayCreate);
  const [createdKey, setCreatedKey] = useState<CreateRagApiKeyResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = usePermittedDialog<RagApiKey | null>(
    null,
    revocable(mayRevoke),
  );

  const {
    data,
    isPending: queryPending,
    isError,
    error,
  } = useQuery({
    queryKey: queryKeys.ragApiKeys,
    queryFn: () => listRagApiKeys(),
    enabled: mayList,
  });
  const keys = visibleKeys(mayList, data);
  // A disabled query never leaves `pending`, so the answer for a role that
  // cannot list is "no keys to show", not "still loading".
  const isPending = mayList && queryPending;
  // The empty state carries its own Create button, so the header one would be a
  // second identical primary action on the same screen. Header yields until
  // there is a list to add to.
  const showEmptyState = !isPending && !isError && keys.length === 0;
  const showActions = mayRevokeAny(keys);

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
          // "Bearer tokens" described the HTTP mechanism rather than what the key
          // does; that detail is already visible in the Authorization header of
          // the sample below, where it is actionable.
          description="Let apps and agents query your indexed buckets. Unlike S3 access keys, they cannot read or write bucket contents."
        >
          API Keys
        </Heading>
        {!showEmptyState && mayCreate && (
          <Button
            variant="primary"
            size="sm"
            icon={PlusIcon}
            className="mt-1 flex-shrink-0"
            onClick={() => setCreateOpen(true)}
          >
            Create API key
          </Button>
        )}
      </div>

      {isError && (
        <Alert
          variant="red"
          description={error instanceof Error ? error.message : 'Failed to load API keys'}
        />
      )}

      {showEmptyState && (
        <div
          data-testid="rag-api-keys-empty"
          className="flex flex-col items-center gap-3 rounded-xl border border-zinc-200 bg-white px-6 py-8 text-center"
        >
          <IconBox icon={KeyIcon} color="grey" size="md" />
          <div>
            <p className="text-sm font-medium text-zinc-900">No API keys yet</p>
            {/* The invitation goes with the button: telling a ReadOnly member to
                create a key, with nothing to click, is a dead end. */}
            <p className="mt-1 text-xs text-zinc-500">
              {mayCreate
                ? 'Create a key to query your indexed buckets from your app or agent.'
                : 'Keys for the Query API appear here.'}
            </p>
          </div>
          {mayCreate && (
            <Button variant="primary" size="sm" icon={PlusIcon} onClick={() => setCreateOpen(true)}>
              Create API key
            </Button>
          )}
        </div>
      )}

      {!isPending && !isError && keys.length > 0 && (
        <RagKeysTable
          keys={keys}
          showActions={showActions}
          mayRevoke={mayRevoke}
          onRequestDelete={setDeleteTarget}
        />
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

      <div className="border-t border-zinc-200 pt-6">
        <ApiReference />
      </div>
    </div>
  );
}
