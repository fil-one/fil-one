import { useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowUpIcon,
  CloudArrowUpIcon,
  TrashIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  KeyIcon,
  CubeIcon,
  HardDrivesIcon,
} from '@phosphor-icons/react/dist/ssr';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { AccessKeysTable } from '../components/AccessKeysTable';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyableField } from '../components/CopyableField';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '../components/Tabs';
import { Breadcrumb } from '../components/Breadcrumb';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { AddBucketKeyModal } from '../components/AddBucketKeyModal';
import { formatBytes, getS3Endpoint, S3_REGION } from '@filone/shared';
import { FILONE_STAGE } from '../env';

import type {
  S3Object,
  ListObjectsResponse,
  GetBucketResponse,
  ListAccessKeysResponse,
} from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { formatDate, formatDateTime } from '../lib/time.js';
import { useObjectActions } from '../lib/use-object-actions.js';
import { queryKeys } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BrowseEntry =
  | { kind: 'folder'; name: string; prefix: string }
  | { kind: 'object'; name: string; object: S3Object };

function getEntriesAtPrefix(objects: S3Object[], prefix: string): BrowseEntry[] {
  const folders = new Set<string>();
  const files: BrowseEntry[] = [];

  for (const obj of objects) {
    if (!obj.key.startsWith(prefix)) continue;
    const remainder = obj.key.slice(prefix.length);
    const slashIdx = remainder.indexOf('/');
    if (slashIdx === -1) {
      // Direct file at this level
      files.push({ kind: 'object', name: remainder, object: obj });
    } else {
      // There's a deeper path — extract the folder name
      folders.add(remainder.slice(0, slashIdx));
    }
  }

  const folderEntries: BrowseEntry[] = [...folders]
    .sort()
    .map((f) => ({ kind: 'folder', name: f, prefix: `${prefix}${f}/` }));

  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...folderEntries, ...files];
}

// ---------------------------------------------------------------------------
// Stat card component
// ---------------------------------------------------------------------------

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ size: number; className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-white px-5 py-4">
      <div className="flex size-10 items-center justify-center rounded-lg bg-zinc-100">
        <Icon size={20} className="text-zinc-500" />
      </div>
      <div>
        <p className="text-2xl font-semibold text-zinc-900">{value}</p>
        <p className="text-xs text-zinc-500">{label}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type BucketDetailPageProps = {
  bucketName: string;
  prefix?: string;
};

// eslint-disable-next-line max-lines-per-function, complexity/complexity
export function BucketDetailPage({ bucketName, prefix }: BucketDetailPageProps) {
  const s3Endpoint = getS3Endpoint(S3_REGION, FILONE_STAGE);
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Prefix-based folder navigation
  const currentPrefix = prefix ?? '';

  const setCurrentPrefix = useCallback(
    (newPrefix: string) => {
      void navigate({
        to: '/buckets/$bucketName',
        params: { bucketName },
        search: newPrefix ? { prefix: newPrefix } : {},
        replace: true,
      });
    },
    [navigate, bucketName],
  );

  // Bucket metadata
  const { data: bucketData } = useQuery({
    queryKey: queryKeys.bucket(bucketName),
    queryFn: () => apiRequest<GetBucketResponse>(`/buckets/${encodeURIComponent(bucketName)}`),
  });
  const bucket = bucketData?.bucket ?? null;

  // Objects
  const {
    data: objectsData,
    isPending: objectsLoading,
    isError: objectsIsError,
    error: objectsError,
  } = useQuery({
    queryKey: queryKeys.objects(bucketName),
    queryFn: () =>
      apiRequest<ListObjectsResponse>(`/buckets/${encodeURIComponent(bucketName)}/objects`),
  });
  const objects = objectsData?.objects ?? [];

  // Access keys scoped to this bucket
  const { data: accessKeysData, isPending: accessKeysLoading } = useQuery({
    queryKey: queryKeys.bucketAccessKeys(bucketName),
    queryFn: () =>
      apiRequest<ListAccessKeysResponse>(`/access-keys?bucket=${encodeURIComponent(bucketName)}`),
  });
  const accessKeys = accessKeysData?.keys ?? [];

  // Add key modal
  const [addKeyOpen, setAddKeyOpen] = useState(false);

  // Confirm dialog state
  const [confirmDeleteObject, setConfirmDeleteObject] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  const objectActions = useObjectActions({
    bucketName,
    onDeleted: (key) => {
      // Optimistically remove the deleted object from cache
      queryClient.setQueryData<ListObjectsResponse>(queryKeys.objects(bucketName), (old) =>
        old ? { ...old, objects: old.objects.filter((o) => o.key !== key) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.objects(bucketName) });
    },
  });

  function handleKeyAdded() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
    void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
  }

  const deleteKeyMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/access-keys/${id}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      queryClient.setQueryData<ListAccessKeysResponse>(
        queryKeys.bucketAccessKeys(bucketName),
        (old) => (old ? { keys: old.keys.filter((k) => k.id !== id) } : old),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      toast.success('Access key deleted');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete key');
    },
  });

  async function handleDeleteKey(id: string) {
    setConfirmDeleteKey(id);
  }

  async function confirmDeleteKeyAction() {
    if (!confirmDeleteKey) return;
    try {
      await deleteKeyMutation.mutateAsync(confirmDeleteKey);
    } catch {
      // error handled by mutation.onError
    }
  }

  if (objectsLoading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading objects" size={32} />
      </div>
    );
  }

  if (objectsIsError) {
    return (
      <div className="p-6">
        <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {objectsError?.message ?? 'Failed to load objects'}
        </div>
      </div>
    );
  }

  const bucketRegion = bucket?.region ?? S3_REGION;

  return (
    <div className="p-6">
      {/* Breadcrumb */}
      <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />

      {/* Page header */}
      <div className="mt-2 mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900">{bucketName}</h1>
        <Button
          variant="primary"
          icon={ArrowUpIcon}
          onClick={() =>
            void navigate({
              to: '/buckets/$bucketName/upload',
              params: { bucketName },
            })
          }
        >
          Upload object
        </Button>
      </div>

      {/* Subtitle */}
      {bucket && (
        <p className="mb-6 text-sm text-zinc-500">
          {bucketRegion} &bull; Created {formatDateTime(bucket.createdAt)}
        </p>
      )}

      {/* Stat cards */}
      {/* TODO: Replace N/A values with real data from Aurora analytics endpoint */}
      <div className="mb-6 grid grid-cols-3 gap-4">
        <StatCard icon={CubeIcon} label="Objects" value="N/A" />
        <StatCard icon={HardDrivesIcon} label="Storage used" value="N/A" />
        <StatCard
          icon={KeyIcon}
          label="API keys"
          value={accessKeysLoading ? '—' : accessKeys.length.toLocaleString()}
        />
      </div>

      {/* Tabs */}
      <Tabs>
        <TabList>
          <Tab>Objects</Tab>
          <Tab>Access</Tab>
        </TabList>

        <TabPanels>
          {/* Objects tab */}
          <TabPanel>
            {objects.length === 0 ? (
              <div className="mt-4 flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
                <CloudArrowUpIcon size={48} className="mb-4 text-zinc-300" aria-hidden="true" />
                <p className="mb-1 text-base font-medium text-zinc-700">No objects yet</p>
                <p className="mb-6 text-sm text-zinc-500">
                  Upload your first object to this bucket
                </p>
                <Button
                  variant="primary"
                  icon={ArrowUpIcon}
                  onClick={() =>
                    void navigate({
                      to: '/buckets/$bucketName/upload',
                      params: { bucketName },
                    })
                  }
                >
                  Upload object
                </Button>
              </div>
            ) : (
              <div className="mt-4">
                {/* Prefix breadcrumb */}
                <div className="mb-2 flex items-center gap-1 text-sm">
                  <button
                    type="button"
                    onClick={() => setCurrentPrefix('')}
                    className={`hover:text-brand-600 ${currentPrefix === '' ? 'font-medium text-zinc-900' : 'text-brand-600'}`}
                  >
                    /
                  </button>
                  {currentPrefix
                    .split('/')
                    .filter(Boolean)
                    .map((segment, idx, arr) => {
                      const segmentPrefix = arr.slice(0, idx + 1).join('/') + '/';
                      const isLast = idx === arr.length - 1;
                      return (
                        <span key={segmentPrefix} className="flex items-center gap-1">
                          <span className="text-zinc-400">/</span>
                          <button
                            type="button"
                            onClick={() => setCurrentPrefix(segmentPrefix)}
                            className={`hover:text-brand-600 ${isLast ? 'font-medium text-zinc-900' : 'text-brand-600'}`}
                          >
                            {segment}
                          </button>
                        </span>
                      );
                    })}
                </div>

                {(() => {
                  const entries = getEntriesAtPrefix(objects, currentPrefix);

                  if (entries.length === 0) {
                    return (
                      <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
                        <p className="text-sm text-zinc-500">No objects at this path</p>
                      </div>
                    );
                  }

                  return (
                    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
                      <table className="w-full text-sm">
                        <thead className="border-b border-zinc-200 bg-zinc-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                              Name
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                              Size
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                              Last Modified
                            </th>
                            <th className="px-4 py-3" aria-label="Actions" />
                          </tr>
                        </thead>
                        <tbody>
                          {entries.map((entry) =>
                            entry.kind === 'folder' ? (
                              <tr
                                key={`folder:${entry.prefix}`}
                                className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 cursor-pointer"
                                onClick={() => setCurrentPrefix(entry.prefix)}
                              >
                                <td className="px-4 py-3">
                                  <div className="flex items-center gap-2 font-medium text-zinc-900">
                                    <FolderIcon
                                      size={16}
                                      className="shrink-0 text-zinc-400"
                                      aria-hidden="true"
                                    />
                                    {entry.name}/
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-zinc-400">—</td>
                                <td className="px-4 py-3 text-zinc-400">—</td>
                                <td className="px-4 py-3" />
                              </tr>
                            ) : (
                              <tr
                                key={`object:${entry.object.key}`}
                                className="border-b border-zinc-100 last:border-0 cursor-pointer hover:bg-zinc-50"
                                role="button"
                                tabIndex={0}
                                onClick={() =>
                                  void navigate({
                                    to: '/buckets/$bucketName/objects',
                                    params: { bucketName },
                                    search: { key: entry.object.key },
                                  })
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    void navigate({
                                      to: '/buckets/$bucketName/objects',
                                      params: { bucketName },
                                      search: { key: entry.object.key },
                                    });
                                  }
                                }}
                              >
                                <td className="px-4 py-3">
                                  <div
                                    className="flex items-center gap-2 font-medium text-zinc-900"
                                    title={entry.object.key}
                                  >
                                    <FileIcon
                                      size={16}
                                      className="shrink-0 text-zinc-400"
                                      aria-hidden="true"
                                    />
                                    {entry.name}
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-zinc-600">
                                  {formatBytes(entry.object.sizeBytes)}
                                </td>
                                <td className="px-4 py-3 text-zinc-600">
                                  {formatDate(entry.object.lastModified)}
                                </td>
                                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                                  <div className="flex items-center justify-end gap-2">
                                    <button
                                      type="button"
                                      aria-label={`Download ${entry.name}`}
                                      onClick={() =>
                                        void objectActions.downloadObject(entry.object.key)
                                      }
                                      disabled={objectActions.downloading === entry.object.key}
                                      className="text-zinc-400 hover:text-brand-600 disabled:opacity-50"
                                    >
                                      {objectActions.downloading === entry.object.key ? (
                                        <Spinner ariaLabel="Downloading" size={16} />
                                      ) : (
                                        <DownloadSimpleIcon size={16} aria-hidden="true" />
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={`Delete ${entry.name}`}
                                      onClick={() => setConfirmDeleteObject(entry.object.key)}
                                      className="text-zinc-400 hover:text-red-500"
                                    >
                                      <TrashIcon size={16} aria-hidden="true" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </div>
            )}
          </TabPanel>

          {/* Access tab */}
          <TabPanel>
            <div className="mt-4">
              {/* API keys section */}
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-medium text-zinc-900">API keys</h2>
                  <p className="text-sm text-zinc-500">Keys with access to this bucket</p>
                </div>
                <Button variant="primary" icon={PlusIcon} onClick={() => setAddKeyOpen(true)}>
                  Add key
                </Button>
              </div>

              {accessKeysLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Spinner ariaLabel="Loading access keys" size={24} />
                </div>
              ) : (
                <AccessKeysTable
                  keys={accessKeys}
                  showPermissions
                  onDelete={handleDeleteKey}
                  onCreateOpen={() => setAddKeyOpen(true)}
                  emptyTitle="No access keys yet"
                  emptyDescription="Create an access key to connect via the S3 API"
                />
              )}

              {/* Access endpoints section */}
              <div className="mt-8">
                <h2 className="mb-3 text-[13px] font-medium text-zinc-900">Access endpoints</h2>
                <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3">
                    <CopyableField label="S3 Endpoint" value={s3Endpoint} />
                    <CopyableField label="S3 Path" value={`s3://${bucketName}`} />
                    <CopyableField label="Region" value={bucketRegion} />
                  </div>
                </div>
              </div>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>

      {/* Add key modal */}
      <AddBucketKeyModal
        open={addKeyOpen}
        onClose={() => setAddKeyOpen(false)}
        bucketName={bucketName}
        onKeyAdded={handleKeyAdded}
      />

      {/* Delete object confirmation */}
      <ConfirmDialog
        open={confirmDeleteObject !== null}
        onClose={() => setConfirmDeleteObject(null)}
        onConfirm={() => {
          if (!confirmDeleteObject) return Promise.resolve();
          return objectActions.deleteObject(confirmDeleteObject);
        }}
        title="Delete object"
        description="This object will be permanently deleted. This action cannot be undone."
        confirmLabel="Delete object"
      />

      {/* Delete access key confirmation */}
      <ConfirmDialog
        open={confirmDeleteKey !== null}
        onClose={() => setConfirmDeleteKey(null)}
        onConfirm={confirmDeleteKeyAction}
        title="Delete access key"
        description="This access key will be permanently revoked. Any applications using it will lose access immediately."
        confirmLabel="Delete key"
      />
    </div>
  );
}
