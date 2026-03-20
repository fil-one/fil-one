import { useEffect, useRef, useState, useCallback } from 'react';
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
  PresignUploadResponse,
} from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { formatDate, formatDateTime } from '../lib/time.js';

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
      files.push({ kind: 'object', name: remainder, object: obj });
    } else {
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
// Upload step type
// ---------------------------------------------------------------------------

type UploadStep = 'select' | 'uploading' | 'done';

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

  // Upload modal state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadStep, setUploadStep] = useState<UploadStep>('select');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [objectName, setObjectName] = useState('');
  const [objectDescription, setObjectDescription] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userEditedName = useRef(false);

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
    setUploadStep('select');
    setSelectedFile(null);
    setObjectName('');
    setObjectDescription('');
    setUploadProgress(0);
    userEditedName.current = false;
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      if (!userEditedName.current) {
        setObjectName(file.name);
      }
    }
  }

  async function handleUpload() {
    if (!selectedFile || !objectName.trim()) return;
    setUploadStep('uploading');
    setUploadProgress(0);

    try {
      const key = objectName.trim();
      const contentType = selectedFile.type || 'application/octet-stream';

      const description = objectDescription.trim() || undefined;
      const presignData = await apiRequest<PresignUploadResponse>(
        `/buckets/${encodeURIComponent(bucketName)}/objects/presign`,
        {
          method: 'POST',
          body: JSON.stringify({
            key,
            contentType,
            fileName: selectedFile.name,
            ...(description && { description }),
          }),
        },
      );
      setUploadProgress(1);

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.max(1, Math.round((e.loaded / e.total) * 100)));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Upload failed'));
        xhr.open('PUT', presignData.url);
        xhr.setRequestHeader('Content-Type', contentType);
        xhr.send(selectedFile);
      });

      setUploadProgress(100);
      setUploadStep('done');
      setObjects((prev) => [
        {
          key,
          sizeBytes: selectedFile.size,
          lastModified: new Date().toISOString(),
        },
        ...prev,
      ]);
      toast.success(`${selectedFile.name} uploaded successfully`);
    } catch (err) {
      console.error('Upload failed:', err);
      handleCloseUploadModal();
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    }
  }

  async function handleDeleteObject(key: string) {
    try {
      await apiRequest(
        `/buckets/${encodeURIComponent(bucketName)}/objects?key=${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      );
      setObjects((prev) => prev.filter((o) => o.key !== key));
      toast.success('Object deleted');
    } catch (err) {
      console.error('Failed to delete object:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to delete object');
    }
  }

  async function handleDownloadObject(key: string) {
    try {
      const data = await apiRequest<{ url: string }>(
        `/buckets/${encodeURIComponent(bucketName)}/objects/download?key=${encodeURIComponent(key)}`,
      );
      window.open(data.url, '_blank');
    } catch (err) {
      console.error('Failed to get download URL:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to get download URL');
    }
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
      <div className="mb-6 grid grid-cols-3 gap-4">
        <StatCard
          icon={CubeIcon}
          label="Objects"
          value={bucket ? bucket.objectCount.toLocaleString() : objects.length.toLocaleString()}
        />
        <StatCard
          icon={HardDrivesIcon}
          label="Storage used"
          value={bucket ? formatBytes(bucket.sizeBytes) : '—'}
        />
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
                                      onClick={() => handleDownloadObject(entry.object.key)}
                                      className="text-zinc-400 hover:text-brand-600"
                                    >
                                      <DownloadSimpleIcon size={16} aria-hidden="true" />
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={`Delete ${entry.name}`}
                                      onClick={() => handleDeleteObject(entry.object.key)}
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

        {uploadStep === 'select' && (
          <>
            <ModalBody>
              <div
                className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-zinc-300 p-8 text-center hover:border-brand-400"
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    fileInputRef.current?.click();
                  }
                }}
              >
                <CloudArrowUpIcon size={32} className="mb-2 text-zinc-400" aria-hidden="true" />
                <p className="text-sm font-medium text-zinc-700">
                  Drop files here or click to browse
                </p>
                <p className="mt-1 text-xs text-zinc-500">Any file type up to 5 GB</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </div>

              {selectedFile && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                  <FileIcon size={16} className="shrink-0 text-zinc-500" aria-hidden="true" />
                  <span className="flex-1 truncate text-sm text-zinc-700">{selectedFile.name}</span>
                  <span className="text-xs text-zinc-500">{formatBytes(selectedFile.size)}</span>
                </div>
              )}

              <div className="mt-4 flex flex-col gap-1.5">
                <label htmlFor="object-name" className="text-sm font-medium text-zinc-700">
                  Object name
                </label>
                <Input
                  id="object-name"
                  value={objectName}
                  onChange={(value) => {
                    userEditedName.current = true;
                    setObjectName(value);
                  }}
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
                  value={objectDescription}
                  onChange={(e) => setObjectDescription(e.target.value)}
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
                  disabled={!selectedFile || !objectName.trim()}
                  onClick={handleUpload}
                >
                  Upload
                </Button>
              </div>
            </ModalFooter>
          </>
        )}

        {uploadStep === 'uploading' && (
          <ModalBody>
            <div className="flex flex-col items-center gap-4 py-4">
              <Spinner ariaLabel="Uploading file" size={40} />
              <p className="text-sm text-zinc-700">Uploading {selectedFile?.name}...</p>
              <ProgressBar value={uploadProgress} className="w-full" label="Upload progress" />
            </div>
          </ModalBody>
        )}

        {uploadStep === 'done' && (
          <>
            <ModalBody>
              <div className="flex flex-col items-center gap-3 py-4">
                <CheckCircleIcon size={40} className="text-green-500" aria-hidden="true" />
                <p className="text-sm font-medium text-zinc-900">Upload complete.</p>
                <p className="text-xs text-zinc-500">
                  {selectedFile?.name} has been stored on Filecoin.
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
    </div>
  );
}
