import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  LinkIcon,
  LockIcon,
  TagIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import { Breadcrumb } from '../components/Breadcrumb';
import { CodeBlock } from '../components/CodeBlock';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyableField } from '../components/CopyableField';
import { Spinner } from '../components/Spinner';
import { formatBytes, getS3Endpoint, S3_REGION } from '@filone/shared';

import type { ObjectMetadataResponse } from '@filone/shared';
import { FILONE_STAGE } from '../env';
import { apiRequest } from '../lib/api.js';
import { formatDateTime } from '../lib/time.js';
import { useObjectActions } from '../lib/use-object-actions.js';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type ObjectDetailPageProps = {
  bucketName: string;
  objectKey: string;
};

export function ObjectDetailPage({ bucketName, objectKey }: ObjectDetailPageProps) {
  const navigate = useNavigate();

  const [metadata, setMetadata] = useState<ObjectMetadataResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const objectActions = useObjectActions({
    bucketName,
    onDeleted: () => {
      void navigate({
        to: '/buckets/$bucketName',
        params: { bucketName },
      });
    },
  });

  // Fetch object metadata on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchMetadata() {
      try {
        const data = await apiRequest<ObjectMetadataResponse>(
          `/buckets/${encodeURIComponent(bucketName)}/objects/metadata?key=${encodeURIComponent(objectKey)}`,
        );
        if (!cancelled) {
          setMetadata(data);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load object metadata:', err);
          setError(err instanceof Error ? err.message : 'Failed to load object metadata');
          setLoading(false);
        }
      }
    }
    void fetchMetadata();
    return () => {
      cancelled = true;
    };
  }, [bucketName, objectKey]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current &&
        !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading object details" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Breadcrumb
          items={[
            { label: 'Buckets', href: '/buckets' },
            { label: bucketName, href: `/buckets/${bucketName}` },
            { label: objectKey },
          ]}
        />
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  // Parse tags from metadata
  let tags: string[] = [];
  if (metadata?.metadata.tags) {
    try {
      const parsed: unknown = JSON.parse(metadata.metadata.tags);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === 'string');
      }
    } catch {
      // ignore invalid JSON
    }
  }

  // Strip surrounding quotes from ETag if present
  const etag = metadata?.etag?.replace(/^"|"$/g, '');

  const s3Path = `s3://${bucketName}/${objectKey}`;

  const s3Endpoint = getS3Endpoint(S3_REGION, FILONE_STAGE);

  const apiExample = `# Retrieve via S3 API
aws s3 cp s3://${bucketName}/${objectKey} ./local-copy \\
  --endpoint-url ${s3Endpoint}`;

  function handleMenuAction(action: () => void) {
    setMenuOpen(false);
    action();
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      {/* Breadcrumb */}
      <Breadcrumb
        items={[
          { label: 'Buckets', href: '/buckets' },
          { label: bucketName, href: `/buckets/${bucketName}` },
          { label: objectKey },
        ]}
      />

      {/* Page header */}
      <div className="mt-2 mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void navigate({ to: '/buckets/$bucketName', params: { bucketName } })}
          className="flex size-8 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-900"
        >
          <ArrowLeftIcon size={16} aria-hidden="true" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">{objectKey}</h1>
          <p className="text-[13px] text-zinc-500">
            <span className="underline">{metadata?.filCid ? 'Sealed on Filecoin' : 'Queued'}</span>
            <span> &bull; {bucketName}</span>
          </p>
        </div>

        {/* Triple-dot action menu */}
        <div className="relative">
          <button
            ref={menuBtnRef}
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="flex size-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Object actions"
          >
            <DotsThreeIcon size={16} weight="bold" />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
            >
              <button
                type="button"
                onClick={() => handleMenuAction(() => void objectActions.downloadObject(objectKey))}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-zinc-900 hover:bg-zinc-50"
              >
                <DownloadSimpleIcon size={14} />
                Download
              </button>
              <button
                type="button"
                onClick={() =>
                  handleMenuAction(() => void objectActions.generatePresignedUrl(objectKey))
                }
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-zinc-900 hover:bg-zinc-50"
              >
                <LinkIcon size={14} />
                Generate presigned URL
              </button>
              <div className="my-1 border-t border-zinc-100" />
              <button
                type="button"
                onClick={() => handleMenuAction(() => setConfirmDeleteOpen(true))}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
              >
                <TrashIcon size={14} />
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {/* CID card */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium text-zinc-900">Content Identifier (CID)</h2>
          <OffloadStatusBadge filCid={metadata?.filCid} />
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          A unique content identifier that lets anyone verify the exact data stored on Filecoin
        </p>
        {metadata?.filCid ? (
          <CopyableField label="" value={metadata.filCid} />
        ) : (
          <div className="rounded-lg bg-zinc-100 px-3 py-2.5">
            <span className="font-mono text-[11px] text-zinc-400">
              CID will be available after Filecoin sealing
            </span>
          </div>
        )}
      </div>

      {/* Object details card */}
      <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-medium text-zinc-900">Object details</h2>
        <div className="flex flex-col gap-2">
          <DetailRow label="Name" value={objectKey} mono />
          {metadata && <DetailRow label="Size" value={formatBytes(metadata.sizeBytes)} mono />}
          <DetailRow label="Bucket" value={bucketName} mono />
          {metadata && (
            <DetailRow label="Created" value={formatDateTime(metadata.lastModified)} mono />
          )}
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-zinc-500">S3 Path</span>
            <CopyableField label="" value={s3Path} />
          </div>
          {etag && (
            <div className="flex items-center justify-between py-1">
              <span className="text-[13px] text-zinc-500">ETag</span>
              <CopyableField label="" value={etag} />
            </div>
          )}
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-zinc-500">Retention</span>
            {metadata?.retention ? (
              <span className="flex items-center gap-1.5 font-mono text-xs text-zinc-900">
                <LockIcon size={12} />
                {metadata.retention.mode === 'COMPLIANCE' ? 'Compliance' : 'Governance'}
                {' \u00b7 Expires '}
                {new Date(metadata.retention.retainUntilDate).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 font-mono text-xs text-zinc-400">
                <LockIcon size={12} />
                None
              </span>
            )}
          </div>
          {metadata?.metadata.description && (
            <div className="flex items-start justify-between pt-2">
              <span className="pt-0.5 text-[13px] text-zinc-500">Description</span>
              <span className="text-right text-[13px] text-zinc-900">
                {metadata.metadata.description}
              </span>
            </div>
          )}
          <div className="flex items-start justify-between pt-2">
            <span className="pt-0.5 text-[13px] text-zinc-500">Tags</span>
            {tags.length > 0 ? (
              <div className="flex flex-wrap justify-end gap-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600"
                  >
                    <TagIcon size={12} />
                    {tag}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-[13px] text-zinc-400">None</span>
            )}
          </div>
        </div>
      </div>

      {metadata?.retention && metadata.retention.mode === 'COMPLIANCE' && (
        <div className="mt-6 rounded-lg border border-red-300/50 p-4">
          <div className="flex items-start gap-3">
            <LockIcon size={16} className="mt-0.5 shrink-0 text-red-600" aria-hidden="true" />
            <p className="text-[13px] text-red-600">
              This object is protected by a compliance retention lock until{' '}
              <span className="font-bold">
                {new Date(metadata.retention.retainUntilDate).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
              . It cannot be deleted before this date.
            </p>
          </div>
        </div>
      )}

      {/* API access example card */}
      <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-medium text-zinc-900">API access example</h2>
        <CodeBlock code={apiExample} language="bash" />
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        onConfirm={() => objectActions.deleteObject(objectKey)}
        title="Delete object"
        description="This object will be permanently deleted. This action cannot be undone."
        confirmLabel="Delete object"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail row helper
// ---------------------------------------------------------------------------

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[13px] text-zinc-500">{label}</span>
      <span className={`text-xs text-zinc-900 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function OffloadStatusBadge({ filCid }: { filCid?: string }) {
  if (filCid) {
    return (
      <span className="rounded-full border border-green-200 bg-green-50 px-2.5 py-0.5 text-[11px] font-semibold text-green-600">
        Sealed
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-500">
      <Spinner ariaLabel="Queued" size={10} />
      Queued
    </span>
  );
}
