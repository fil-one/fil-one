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
} from '@phosphor-icons/react/dist/ssr';

import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../components/Modal';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '../components/Tabs';
import { Breadcrumb } from '../components/Breadcrumb';
import { Spinner } from '../components/Spinner';
import { ProgressBar } from '../components/ProgressBar';
import { useToast } from '../components/Toast';
import { formatBytes } from '@filone/shared';

import type {
  S3Object,
  AccessKey,
  ListObjectsResponse,
  PresignUploadResponse,
} from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { formatDate } from '../lib/time.js';

// ---------------------------------------------------------------------------
// Mock data (access keys — placeholder, out of scope)
// ---------------------------------------------------------------------------

const MOCK_ACCESS_KEYS: AccessKey[] = [
  {
    id: '1',
    keyName: 'Production',
    accessKeyId: 'HKIAXXX...ABCD',
    createdAt: '2024-01-15T10:00:00Z',
    lastUsedAt: '2024-02-15T10:00:00Z',
    status: 'active',
    permissions: ['read', 'write', 'list', 'delete'],
    bucketScope: 'all',
    expiresAt: null,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BrowseEntry =
  | { kind: 'folder'; name: string; prefix: string }
  | { kind: 'object'; name: string; object: S3Object };

/**
 * Given a flat list of objects and a current prefix, returns the immediate
 * child folders and files — like S3 console prefix browsing.
 */
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

/** Masks an access key ID: shows first 4 chars + ...XXXX */
function maskAccessKeyId(id: string): string {
  if (id.length <= 4) return id;
  return `${id.slice(0, 4)}...XXXX`;
}

// ---------------------------------------------------------------------------
// Upload step type
// ---------------------------------------------------------------------------

type UploadStep = 'select' | 'uploading' | 'done';

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

  // Objects state
  const [objects, setObjects] = useState<S3Object[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Prefix-based folder navigation — driven by URL search param
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
  const [accessKeys] = useState<AccessKey[]>(MOCK_ACCESS_KEYS);

  // Upload modal state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadStep, setUploadStep] = useState<UploadStep>('select');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [objectName, setObjectName] = useState('');
  const [objectDescription, setObjectDescription] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Track whether the user has manually edited the object name
  const userEditedName = useRef(false);

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
      // Auto-fill object name from filename if user hasn't manually set it
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

      // Step 1: Get presigned URL
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

      // Step 2: Upload directly to Aurora S3 via XHR for real progress.
      // We use XMLHttpRequest instead of fetch() because the Fetch API does not
      // support upload progress tracking.
      // See https://jakearchibald.com/2025/fetch-streams-not-for-progress/
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            // Never drop below 1% — we already showed progress for the presign step
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
      toast.error(err instanceof Error ? err.message : 'Failed to delete object');
    }
  }

  async function handleDownloadObject(key: string) {
    try {
      const data = await apiRequest<{ url: string }>(
        `/buckets/${encodeURIComponent(bucketName)}/objects/download?key=${encodeURIComponent(key)}`,
      );
      // Open the presigned S3 URL — triggers browser download
      window.open(data.url, '_blank');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to get download URL');
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

  return (
    <div className="p-6">
      {/* Breadcrumb */}
      <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />

      {/* Page header */}
      <div className="mt-2 mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900">{bucketName}</h1>
        <Button variant="filled" icon={ArrowUpIcon} onClick={() => setUploadOpen(true)}>
          Upload object
        </Button>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Tabs */}
      {/* ------------------------------------------------------------------ */}
      <Tabs>
        <TabList>
          <Tab>Objects</Tab>
          <Tab>Access</Tab>
        </TabList>

        <TabPanels>
          {/* ---------------------------------------------------------------- */}
          {/* Objects tab */}
          {/* ---------------------------------------------------------------- */}
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

          {/* ---------------------------------------------------------------- */}
          {/* Access tab */}
          {/* ---------------------------------------------------------------- */}
          <TabPanel>
            <div className="mt-4">
              {/* Row above table */}
              <div className="mb-4 flex items-center justify-between">
                <p className="text-sm text-zinc-600">Access keys scoped to this bucket</p>
                <Button
                  variant="filled"
                  icon={PlusIcon}
                  // UNKNOWN: create access key flow not yet specified — placeholder onClick
                  onClick={() => toast.info('Create access key is not yet implemented')}
                >
                  Create access key
                </Button>
              </div>

              {accessKeys.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
                  <KeyIcon size={48} className="mb-4 text-zinc-300" aria-hidden="true" />
                  <p className="mb-1 text-base font-medium text-zinc-700">No access keys yet</p>
                  <p className="text-sm text-zinc-500">
                    Create an access key to connect via the S3 API
                  </p>
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
                  <table className="w-full text-sm">
                    <thead className="border-b border-zinc-200 bg-zinc-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                          Name
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                          Access Key ID
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                          Created
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                          Last Used
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                          Status
                        </th>
                        <th className="px-4 py-3" aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {accessKeys.map((key) => (
                        <tr
                          key={key.id}
                          className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
                        >
                          <td className="px-4 py-3 font-medium text-zinc-900">{key.keyName}</td>
                          <td className="px-4 py-3 font-mono text-xs text-zinc-600">
                            {maskAccessKeyId(key.accessKeyId)}
                          </td>
                          <td className="px-4 py-3 text-zinc-600">{formatDate(key.createdAt)}</td>
                          <td className="px-4 py-3 text-zinc-600">
                            {key.lastUsedAt ? formatDate(key.lastUsedAt) : '—'}
                          </td>
                          <td className="px-4 py-3">
                            {key.status === 'active' ? (
                              <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                                Active
                              </span>
                            ) : (
                              <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                                Inactive
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              aria-label={`Delete access key ${key.keyName}`}
                              onClick={() => toast.info('Delete access key is not yet implemented')}
                              className="text-zinc-400 hover:text-red-500"
                            >
                              <TrashIcon size={16} aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>

      {/* ------------------------------------------------------------------ */}
      {/* Upload Object Modal */}
      {/* ------------------------------------------------------------------ */}
      <Modal open={uploadOpen} onClose={handleCloseUploadModal} size="md">
        <ModalHeader onClose={handleCloseUploadModal}>Upload object</ModalHeader>

        {uploadStep === 'select' && (
          <>
            <ModalBody>
              {/* Drop zone */}
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

              {/* Object name (required) */}
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

              {/* Description (optional) */}
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
                <p className="text-sm font-medium text-zinc-900">Upload complete!</p>
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
    </div>
  );
}
