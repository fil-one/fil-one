import { useRef, useState } from 'react'
import {
  ArrowUpIcon,
  CloudArrowUpIcon,
  TrashIcon,
  DownloadSimpleIcon,
  FileIcon,
  CheckCircleIcon,
  PlusIcon,
  KeyIcon,
} from '@phosphor-icons/react/dist/ssr'

import { Button } from '@hyperspace/ui/Button'
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@hyperspace/ui/Modal'
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '@hyperspace/ui/Tabs'
import { Breadcrumb } from '@hyperspace/ui/Breadcrumb'
import { Spinner } from '@hyperspace/ui/Spinner'
import { ProgressBar } from '@hyperspace/ui/ProgressBar'
import { useToast } from '@hyperspace/ui/Toast'

import type { S3Object, AccessKey } from '@hyperspace/shared'

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_OBJECTS: S3Object[] = [
  {
    key: 'videos/intro.mp4',
    sizeBytes: 104857600,
    lastModified: '2024-02-10T14:00:00Z',
    etag: '"abc123"',
    contentType: 'video/mp4',
    cid: 'bafybeigdyr...',
  },
  {
    key: 'images/hero.png',
    sizeBytes: 2097152,
    lastModified: '2024-02-09T10:00:00Z',
    etag: '"def456"',
    contentType: 'image/png',
    cid: 'bafybeiczsz...',
  },
  {
    key: 'docs/readme.txt',
    sizeBytes: 4096,
    lastModified: '2024-02-08T08:00:00Z',
    etag: '"ghi789"',
    contentType: 'text/plain',
    cid: undefined,
  },
]

const MOCK_ACCESS_KEYS: AccessKey[] = [
  {
    id: '1',
    name: 'Production',
    accessKeyId: 'HKIAXXX...ABCD',
    createdAt: '2024-01-15T10:00:00Z',
    lastUsedAt: '2024-02-15T10:00:00Z',
    status: 'active',
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

/** Returns just the filename portion of a key (after last '/') */
function objectDisplayName(key: string): string {
  const parts = key.split('/')
  return parts[parts.length - 1] ?? key
}

/** Masks an access key ID: shows first 4 chars + ...XXXX */
function maskAccessKeyId(id: string): string {
  if (id.length <= 4) return id
  return `${id.slice(0, 4)}...XXXX`
}

// ---------------------------------------------------------------------------
// Upload step type
// ---------------------------------------------------------------------------

type UploadStep = 'select' | 'uploading' | 'done'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type BucketDetailPageProps = {
  bucketName: string
}

export function BucketDetailPage({ bucketName }: BucketDetailPageProps) {
  const { toast } = useToast()

  // Objects state
  const [objects, setObjects] = useState<S3Object[]>(MOCK_OBJECTS)

  // Access keys state
  // UNKNOWN: access keys are per-bucket in this UI but the spec does not clarify
  // whether they are truly scoped to a bucket or global — using mock data as-is
  const [accessKeys] = useState<AccessKey[]>(MOCK_ACCESS_KEYS)

  // Upload modal state
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadStep, setUploadStep] = useState<UploadStep>('select')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Upload simulation timer ref (for cleanup)
  const uploadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function handleCloseUploadModal() {
    setUploadOpen(false)
    setUploadStep('select')
    setSelectedFile(null)
    setUploadProgress(0)
    if (uploadTimerRef.current) {
      clearInterval(uploadTimerRef.current)
      uploadTimerRef.current = null
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) setSelectedFile(file)
  }

  function handleUpload() {
    if (!selectedFile) return
    setUploadStep('uploading')
    setUploadProgress(0)

    // Simulate upload progress over ~2s (20 intervals × 100ms)
    let progress = 0
    uploadTimerRef.current = setInterval(() => {
      progress += 5
      setUploadProgress(progress)
      if (progress >= 100) {
        if (uploadTimerRef.current) {
          clearInterval(uploadTimerRef.current)
          uploadTimerRef.current = null
        }
        setUploadStep('done')
        // Add mock object to local list
        if (selectedFile) {
          const newObject: S3Object = {
            key: selectedFile.name,
            sizeBytes: selectedFile.size,
            lastModified: new Date().toISOString(),
            etag: `"${Math.random().toString(36).slice(2, 10)}"`,
            contentType: selectedFile.type || 'application/octet-stream',
            cid: undefined,
          }
          setObjects((prev) => [newObject, ...prev])
          toast.success(`${selectedFile.name} uploaded successfully`)
        }
      }
    }, 100)
  }

  function handleDeleteObject(key: string) {
    setObjects((prev) => prev.filter((o) => o.key !== key))
    toast.success(`Object deleted`)
  }

  // UNKNOWN: download is not implemented (no presigned URL API) — linking to # as placeholder
  function handleDownloadObject(key: string) {
    toast.info(`Download for "${objectDisplayName(key)}" is not yet implemented`)
  }

  return (
    <div className="p-6">
      {/* Breadcrumb */}
      <Breadcrumb
        items={[
          { label: 'Buckets', href: '/buckets' },
          { label: bucketName },
        ]}
      />

      {/* Page header */}
      <div className="mt-2 mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900">{bucketName}</h1>
        <Button
          variant="filled"
          icon={ArrowUpIcon}
          onClick={() => setUploadOpen(true)}
        >
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
                <CloudArrowUpIcon
                  size={48}
                  className="mb-4 text-zinc-300"
                  aria-hidden="true"
                />
                <p className="mb-1 text-base font-medium text-zinc-700">
                  No objects yet
                </p>
                <p className="mb-6 text-sm text-zinc-500">
                  Upload your first object to this bucket
                </p>
                <Button
                  variant="filled"
                  icon={ArrowUpIcon}
                  onClick={() => setUploadOpen(true)}
                >
                  Upload object
                </Button>
              </div>
            ) : (
              <div className="mt-4 overflow-hidden rounded-lg border border-zinc-200 bg-white">
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
                        Content Type
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                        Last Modified
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                        CID
                      </th>
                      <th className="px-4 py-3" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {objects.map((obj) => (
                      <tr
                        key={obj.key}
                        className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
                      >
                        <td
                          className="px-4 py-3 font-medium text-zinc-900"
                          title={obj.key}
                        >
                          {objectDisplayName(obj.key)}
                        </td>
                        <td className="px-4 py-3 text-zinc-600">
                          {formatBytes(obj.sizeBytes)}
                        </td>
                        <td className="px-4 py-3 text-zinc-600">
                          {obj.contentType}
                        </td>
                        <td className="px-4 py-3 text-zinc-600">
                          {new Date(obj.lastModified).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          {obj.cid ? (
                            <span
                              className="font-mono text-xs text-zinc-600"
                              title={obj.cid}
                            >
                              {obj.cid.slice(0, 12)}...
                            </span>
                          ) : (
                            <span className="text-zinc-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              aria-label={`Download ${objectDisplayName(obj.key)}`}
                              onClick={() => handleDownloadObject(obj.key)}
                              className="text-zinc-400 hover:text-brand-600"
                            >
                              <DownloadSimpleIcon size={16} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete ${objectDisplayName(obj.key)}`}
                              onClick={() => handleDeleteObject(obj.key)}
                              className="text-zinc-400 hover:text-red-500"
                            >
                              <TrashIcon size={16} aria-hidden="true" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                <p className="text-sm text-zinc-600">
                  Access keys scoped to this bucket
                </p>
                <Button
                  variant="filled"
                  icon={PlusIcon}
                  // UNKNOWN: create access key flow not yet specified — placeholder onClick
                  onClick={() =>
                    toast.info('Create access key is not yet implemented')
                  }
                >
                  Create access key
                </Button>
              </div>

              {accessKeys.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
                  <KeyIcon
                    size={48}
                    className="mb-4 text-zinc-300"
                    aria-hidden="true"
                  />
                  <p className="mb-1 text-base font-medium text-zinc-700">
                    No access keys yet
                  </p>
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
                          <td className="px-4 py-3 font-medium text-zinc-900">
                            {key.name}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-zinc-600">
                            {maskAccessKeyId(key.accessKeyId)}
                          </td>
                          <td className="px-4 py-3 text-zinc-600">
                            {new Date(key.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3 text-zinc-600">
                            {key.lastUsedAt
                              ? new Date(key.lastUsedAt).toLocaleDateString()
                              : '—'}
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
                              aria-label={`Delete access key ${key.name}`}
                              onClick={() =>
                                toast.info('Delete access key is not yet implemented')
                              }
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
      <Modal
        open={uploadOpen}
        onClose={handleCloseUploadModal}
        size="md"
      >
        <ModalHeader onClose={handleCloseUploadModal}>
          Upload object
        </ModalHeader>

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
                    fileInputRef.current?.click()
                  }
                }}
              >
                <CloudArrowUpIcon
                  size={32}
                  className="mb-2 text-zinc-400"
                  aria-hidden="true"
                />
                <p className="text-sm font-medium text-zinc-700">
                  Drop files here or click to browse
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  Any file type up to 5 GB
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </div>

              {selectedFile && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                  <FileIcon
                    size={16}
                    className="shrink-0 text-zinc-500"
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate text-sm text-zinc-700">
                    {selectedFile.name}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {formatBytes(selectedFile.size)}
                  </span>
                </div>
              )}
            </ModalBody>
            <ModalFooter>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={handleCloseUploadModal}>
                  Cancel
                </Button>
                <Button
                  variant="filled"
                  disabled={!selectedFile}
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
              <p className="text-sm text-zinc-700">
                Uploading {selectedFile?.name}...
              </p>
              <ProgressBar
                value={uploadProgress}
                className="w-full"
                label="Upload progress"
              />
            </div>
          </ModalBody>
        )}

        {uploadStep === 'done' && (
          <>
            <ModalBody>
              <div className="flex flex-col items-center gap-3 py-4">
                <CheckCircleIcon
                  size={40}
                  className="text-green-500"
                  aria-hidden="true"
                />
                <p className="text-sm font-medium text-zinc-900">
                  Upload complete!
                </p>
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
  )
}
