import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowUpIcon,
  CloudArrowUpIcon,
  TrashIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderIcon,
  CheckCircleIcon,
  PlusIcon,
  KeyIcon,
  CubeIcon,
  HardDrivesIcon,
} from '@phosphor-icons/react/dist/ssr';

import { AccessKeysTable } from '../components/AccessKeysTable';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyableField } from '../components/CopyableField';
import { Input } from '../components/Input';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../components/Modal';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '../components/Tabs';
import { Breadcrumb } from '../components/Breadcrumb';
import { Spinner } from '../components/Spinner';
import { ProgressBar } from '../components/ProgressBar';
import { useToast } from '../components/Toast';
import { AddBucketKeyModal } from '../components/AddBucketKeyModal';
import { formatBytes, S3_ENDPOINT, S3_REGION } from '@filone/shared';

import type {
  Bucket,
  S3Object,
  AccessKey,
  ListObjectsResponse,
  GetBucketResponse,
  ListAccessKeysResponse,
} from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { formatDate, formatDateTime } from '../lib/time.js';
import { useFileUpload } from '../lib/use-file-upload.js';
import { useObjectActions } from '../lib/use-object-actions.js';

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

export function BucketDetailPage({ bucketName, prefix }: BucketDetailPageProps) {
  const { toast } = useToast();
  const navigate = useNavigate();

  // Bucket metadata
  const [bucket, setBucket] = useState<Bucket | null>(null);

  // Objects state
  const [objects, setObjects] = useState<S3Object[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Access keys state
  const [accessKeys, setAccessKeys] = useState<AccessKey[]>([]);
  const [accessKeysLoading, setAccessKeysLoading] = useState(true);

  // Add key modal
  const [addKeyOpen, setAddKeyOpen] = useState(false);

  // Confirm dialog state
  const [confirmDeleteObject, setConfirmDeleteObject] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  // Upload modal state
  const [uploadOpen, setUploadOpen] = useState(false);

  const upload = useFileUpload({
    bucketName,
    onSuccess: (key, file) => {
      setObjects((prev) => [
        {
          key,
          sizeBytes: file.size,
          lastModified: new Date().toISOString(),
        },
        ...prev,
      ]);
    },
  });

  const objectActions = useObjectActions({
    bucketName,
    onDeleted: (key) => setObjects((prev) => prev.filter((o) => o.key !== key)),
  });

  // Fetch bucket metadata
  useEffect(() => {
    let cancelled = false;
    async function fetchBucket() {
      try {
        const data = await apiRequest<GetBucketResponse>(
          `/buckets/${encodeURIComponent(bucketName)}`,
        );
        if (!cancelled) {
          setBucket(data.bucket);
        }
      } catch (err) {
        console.error('Failed to load bucket metadata:', err);
      }
    }
    void fetchBucket();
    return () => {
      cancelled = true;
    };
  }, [bucketName]);

  // Fetch objects on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchObjects() {
      try {
        const data = await apiRequest<ListObjectsResponse>(
          `/buckets/${encodeURIComponent(bucketName)}/objects`,
        );
        if (!cancelled) {
          setObjects(data.objects);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load objects:', err);
          setError(err instanceof Error ? err.message : 'Failed to load objects');
          setLoading(false);
        }
      }
    }
    void fetchObjects();
    return () => {
      cancelled = true;
    };
  }, [bucketName]);

  // Fetch access keys for this bucket
  useEffect(() => {
    let cancelled = false;
    async function fetchKeys() {
      try {
        const data = await apiRequest<ListAccessKeysResponse>(
          `/access-keys?bucket=${encodeURIComponent(bucketName)}`,
        );
        if (!cancelled) {
          setAccessKeys(data.keys);
          setAccessKeysLoading(false);
        }
      } catch {
        if (!cancelled) {
          setAccessKeysLoading(false);
        }
      }
    }
    void fetchKeys();
    return () => {
      cancelled = true;
    };
  }, [bucketName]);

  function handleCloseUploadModal() {
    setUploadOpen(false);
    upload.reset();
  }

  async function handleKeyAdded() {
    setAccessKeysLoading(true);
    try {
      const data = await apiRequest<ListAccessKeysResponse>(
        `/access-keys?bucket=${encodeURIComponent(bucketName)}`,
      );
      setAccessKeys(data.keys);
    } catch (err) {
      console.error('Failed to refresh access keys:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to refresh access keys');
    } finally {
      setAccessKeysLoading(false);
    }
  }

  async function handleDeleteKey(id: string) {
    setConfirmDeleteKey(id);
  }

  async function confirmDeleteKeyAction() {
    if (!confirmDeleteKey) return;
    const id = confirmDeleteKey;
    try {
      await apiRequest(`/access-keys/${id}`, { method: 'DELETE' });
      setAccessKeys((prev) => prev.filter((k) => k.id !== id));
      toast.success('Access key deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete key');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading objects" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
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
        <Button variant="filled" icon={ArrowUpIcon} onClick={() => setUploadOpen(true)}>
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
                <Button variant="filled" icon={ArrowUpIcon} onClick={() => setUploadOpen(true)}>
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
                                className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
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
                                <td className="px-4 py-3">
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
                <Button variant="filled" icon={PlusIcon} onClick={() => setAddKeyOpen(true)}>
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
                    <CopyableField label="S3 Endpoint" value={S3_ENDPOINT} />
                    <CopyableField label="S3 Path" value={`s3://${bucketName}`} />
                    <CopyableField label="Region" value={bucketRegion} />
                  </div>
                </div>
              </div>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>

      {/* Upload Object Modal */}
      <Modal open={uploadOpen} onClose={handleCloseUploadModal} size="md">
        <ModalHeader onClose={handleCloseUploadModal}>Upload object</ModalHeader>

        {upload.uploadStep === 'idle' && (
          <>
            <ModalBody>
              <div
                className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-zinc-300 p-8 text-center hover:border-brand-400"
                onClick={() => upload.fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    upload.fileInputRef.current?.click();
                  }
                }}
              >
                <CloudArrowUpIcon size={32} className="mb-2 text-zinc-400" aria-hidden="true" />
                <p className="text-sm font-medium text-zinc-700">
                  Drop files here or click to browse
                </p>
                <p className="mt-1 text-xs text-zinc-500">Any file type up to 5 GB</p>
                <input
                  ref={upload.fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={upload.handleFileSelect}
                />
              </div>

              {upload.selectedFile && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                  <FileIcon size={16} className="shrink-0 text-zinc-500" aria-hidden="true" />
                  <span className="flex-1 truncate text-sm text-zinc-700">
                    {upload.selectedFile.name}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {formatBytes(upload.selectedFile.size)}
                  </span>
                </div>
              )}

              <div className="mt-4 flex flex-col gap-1.5">
                <label htmlFor="object-name" className="text-sm font-medium text-zinc-700">
                  Object name
                </label>
                <Input
                  id="object-name"
                  value={upload.objectName}
                  onChange={upload.handleObjectNameChange}
                  placeholder="path/to/my-file.txt"
                  autoComplete="off"
                />
                <p className="text-xs text-zinc-500">
                  Can include slashes to create a folder-like path, e.g.{' '}
                  <code>images/photo.png</code>
                </p>
              </div>

              <div className="mt-4 flex flex-col gap-1.5">
                <label htmlFor="object-description" className="text-sm font-medium text-zinc-700">
                  Description <span className="font-normal text-zinc-400">(optional)</span>
                </label>
                <textarea
                  id="object-description"
                  value={upload.objectDescription}
                  onChange={(e) => upload.setObjectDescription(e.target.value)}
                  placeholder="A short description of this object"
                  rows={2}
                  className="block w-full rounded-lg border border-zinc-200 p-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-2 focus:outline-brand-600"
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={handleCloseUploadModal}>
                  Cancel
                </Button>
                <Button
                  variant="filled"
                  disabled={!upload.selectedFile || !upload.objectName.trim()}
                  onClick={upload.handleUpload}
                >
                  Upload
                </Button>
              </div>
            </ModalFooter>
          </>
        )}

        {upload.uploadStep === 'uploading' && (
          <ModalBody>
            <div className="flex flex-col items-center gap-4 py-4">
              <Spinner ariaLabel="Uploading file" size={40} />
              <p className="text-sm text-zinc-700">Uploading {upload.selectedFile?.name}...</p>
              <ProgressBar
                value={upload.uploadProgress}
                className="w-full"
                label="Upload progress"
              />
            </div>
          </ModalBody>
        )}

        {upload.uploadStep === 'done' && (
          <>
            <ModalBody>
              <div className="flex flex-col items-center gap-3 py-4">
                <CheckCircleIcon size={40} className="text-green-500" aria-hidden="true" />
                <p className="text-sm font-medium text-zinc-900">Upload complete.</p>
                <p className="text-xs text-zinc-500">
                  {upload.selectedFile?.name} has been stored on Filecoin.
                </p>
              </div>
            </ModalBody>
            <ModalFooter>
              <div className="flex justify-end">
                <Button variant="filled" onClick={handleCloseUploadModal}>
                  Done
                </Button>
              </div>
            </ModalFooter>
          </>
        )}
      </Modal>

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
