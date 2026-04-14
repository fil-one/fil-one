import { useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  CloudArrowUpIcon,
  FileIcon,
  XIcon,
  CheckCircleIcon,
} from '@phosphor-icons/react/dist/ssr';

import { formatBytes } from '@filone/shared';

import { Breadcrumb } from '../components/Breadcrumb';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { ProgressBar } from '../components/ProgressBar';
import { Spinner } from '../components/Spinner';
import { useFileUpload } from '../lib/use-file-upload.js';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type UploadObjectPageProps = {
  bucketName: string;
};

// eslint-disable-next-line max-lines-per-function
export function UploadObjectPage({ bucketName }: UploadObjectPageProps) {
  const navigate = useNavigate();

  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');

  const upload = useFileUpload({
    bucketName,
    tags,
    onSuccess: () => {
      void navigate({ to: '/buckets/$bucketName', params: { bucketName } });
    },
  });

  // ---- Tag helpers --------------------------------------------------------

  const addTag = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (value && !tags.includes(value)) {
        setTags((prev) => [...prev, value]);
      }
      setTagInput('');
    },
    [tags],
  );

  const removeTag = useCallback((tag: string) => {
    setTags((prev) => prev.filter((t) => t !== tag));
  }, []);

  function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInput);
    }
    // Allow backspace to remove last tag when input is empty
    if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      setTags((prev) => prev.slice(0, -1));
    }
  }

  // ---- Render helpers -----------------------------------------------------

  const canUpload = !!upload.selectedFile && !!upload.objectName.trim();

  return (
    <div className="mx-auto max-w-2xl p-6">
      {/* Breadcrumb */}
      <Breadcrumb
        items={[
          { label: 'Buckets', href: '/buckets' },
          { label: bucketName, href: `/buckets/${bucketName}` },
          { label: 'Upload object' },
        ]}
      />

      {/* Back + header */}
      <div className="mt-2 mb-6 flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate({ to: '/buckets/$bucketName', params: { bucketName } })}
          className="flex size-9 items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900"
        >
          <ArrowLeftIcon size={16} aria-hidden="true" />
        </button>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">Upload object</h1>
          <p className="text-[13px] text-zinc-500">Upload files to store on Filecoin</p>
        </div>
      </div>

      {/* Idle — form */}
      {upload.uploadStep === 'idle' && (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-5">
            {/* File dropzone */}
            <div className="flex flex-col gap-2.5">
              <label className="text-xs font-medium text-zinc-900">File</label>

              {!upload.selectedFile ? (
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
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                  <FileIcon size={16} className="shrink-0 text-zinc-500" aria-hidden="true" />
                  <span className="flex-1 truncate text-sm text-zinc-700">
                    {upload.selectedFile.name}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {formatBytes(upload.selectedFile.size)}
                  </span>
                  <button
                    type="button"
                    aria-label="Remove file"
                    onClick={() => upload.reset()}
                    className="text-zinc-400 hover:text-zinc-700"
                  >
                    <XIcon size={14} aria-hidden="true" />
                  </button>
                </div>
              )}

              <input
                ref={upload.fileInputRef}
                type="file"
                className="hidden"
                onChange={upload.handleFileSelect}
              />
            </div>

            {/* Object name */}
            <div className="flex flex-col gap-2.5">
              <label htmlFor="object-name" className="text-xs font-medium text-zinc-900">
                Object name
              </label>
              <Input
                id="object-name"
                value={upload.objectName}
                onChange={upload.handleObjectNameChange}
                placeholder="path/to/my-file.txt"
                autoComplete="off"
              />
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Can include slashes to create a folder-like path, e.g. <code>images/photo.png</code>
              </p>
            </div>

            {/* Description */}
            <div className="flex flex-col gap-2.5">
              <label htmlFor="object-description" className="text-xs font-medium text-zinc-900">
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

            {/* Tags */}
            <div className="flex flex-col gap-2.5">
              <label htmlFor="object-tags" className="text-xs font-medium text-zinc-900">
                Tags <span className="font-normal text-zinc-400">(optional)</span>
              </label>

              {/* Tag chips */}
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700"
                    >
                      {tag}
                      <button
                        type="button"
                        aria-label={`Remove tag ${tag}`}
                        onClick={() => removeTag(tag)}
                        className="text-zinc-400 hover:text-zinc-700"
                      >
                        <XIcon size={10} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <Input
                id="object-tags"
                value={tagInput}
                onChange={setTagInput}
                onKeyDown={handleTagKeyDown}
                placeholder="Type a tag and press Enter"
                autoComplete="off"
              />
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Press Enter or comma to add a tag.
              </p>
            </div>

            {/* Submit */}
            <Button
              variant="filled"
              icon={ArrowUpIcon}
              disabled={!canUpload}
              onClick={upload.handleUpload}
            >
              Upload object
            </Button>
          </div>
        </div>
      )}

      {/* Uploading state */}
      {upload.uploadStep === 'uploading' && (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4">
            {/* File info */}
            {upload.selectedFile && (
              <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <FileIcon size={16} className="shrink-0 text-zinc-500" aria-hidden="true" />
                <span className="flex-1 truncate text-sm text-zinc-700">
                  {upload.selectedFile.name}
                </span>
                <span className="text-xs text-zinc-500">
                  {formatBytes(upload.selectedFile.size)}
                </span>
              </div>
            )}

            {/* Progress */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Spinner ariaLabel="Uploading file" size={16} />
                  <span className="text-sm font-medium text-zinc-700">Uploading...</span>
                </div>
                <span className="text-sm text-zinc-500">{upload.uploadProgress}%</span>
              </div>
              <ProgressBar
                value={upload.uploadProgress}
                className="w-full"
                label="Upload progress"
              />
            </div>

            <p className="text-xs text-zinc-500">Your upload will continue in the background.</p>
          </div>
        </div>
      )}

      {/* Done state */}
      {upload.uploadStep === 'done' && (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircleIcon size={40} className="text-green-500" aria-hidden="true" />
            <p className="text-sm font-medium text-zinc-900">Upload complete.</p>
            <p className="text-xs text-zinc-500">
              {upload.selectedFile?.name} has been stored on Filecoin.
            </p>
            <Button
              variant="filled"
              onClick={() => void navigate({ to: '/buckets/$bucketName', params: { bucketName } })}
            >
              Back to bucket
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
