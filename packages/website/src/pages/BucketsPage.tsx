import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { PlusIcon, DatabaseIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { S3_REGION } from '@filone/shared';

import type {
  Bucket,
  CreateBucketRequest,
  CreateBucketResponse,
  ListBucketsResponse,
} from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { formatDate } from '../lib/time.js';
import { CreateAccessKeyModal } from '../components/CreateAccessKeyModal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BucketsPage() {
  const { toast } = useToast();

  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create bucket modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [region, setRegion] = useState(S3_REGION);

  // Create access key modal state (shown after bucket creation)
  const [accessKeyOpen, setAccessKeyOpen] = useState(false);

  const deleteBucket = useRef<string | null>(null);

  // Fetch buckets on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchBuckets() {
      try {
        const data = await apiRequest<ListBucketsResponse>('/buckets');
        if (!cancelled) {
          setBuckets(data.buckets);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load buckets');
          setLoading(false);
        }
      }
    }
    void fetchBuckets();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const body: CreateBucketRequest = { name: name.trim(), region };
      const data = await apiRequest<CreateBucketResponse>('/buckets', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setBuckets((prev) => [data.bucket, ...prev]);
      setCreateOpen(false);
      setName('');
      setRegion(S3_REGION);
      toast.success('Bucket created successfully');
      setAccessKeyOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create bucket');
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteBucket(bucketName: string) {
    deleteBucket.current = bucketName;
    try {
      await apiRequest(`/buckets/${encodeURIComponent(bucketName)}`, {
        method: 'DELETE',
      });
      setBuckets((prev) => prev.filter((b) => b.name !== bucketName));
      toast.success(`Bucket "${bucketName}" deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete bucket');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading buckets" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* ------------------------------------------------------------------ */}
      {/* Page header */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900">Buckets</h1>
        <Button variant="filled" icon={PlusIcon} onClick={() => setCreateOpen(true)}>
          Create bucket
        </Button>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Content: empty state or table */}
      {/* ------------------------------------------------------------------ */}
      {buckets.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
          <DatabaseIcon size={48} className="mb-4 text-zinc-300" aria-hidden="true" />
          <p className="mb-1 text-base font-medium text-zinc-700">No buckets yet</p>
          <p className="mb-6 text-sm text-zinc-500">
            Create your first bucket to start storing objects
          </p>
          <Button variant="filled" icon={PlusIcon} onClick={() => setCreateOpen(true)}>
            Create bucket
          </Button>
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
                  Region
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Created
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Visibility
                </th>
                <th className="px-4 py-3" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr
                  key={bucket.name}
                  className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
                >
                  <td className="px-4 py-3">
                    <Link
                      to="/buckets/$bucketName"
                      params={{ bucketName: bucket.name }}
                      className="font-medium text-zinc-900 hover:text-brand-600"
                    >
                      {bucket.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{bucket.region}</td>
                  <td className="px-4 py-3 text-zinc-600">{formatDate(bucket.createdAt)}</td>
                  <td className="px-4 py-3">
                    {bucket.isPublic ? (
                      <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                        Public
                      </span>
                    ) : (
                      <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                        Private
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      aria-label={`Delete bucket ${bucket.name}`}
                      onClick={() => handleDeleteBucket(bucket.name)}
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

      {/* ------------------------------------------------------------------ */}
      {/* Create Bucket Modal */}
      {/* ------------------------------------------------------------------ */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} size="sm">
        <ModalHeader onClose={() => setCreateOpen(false)}>Create bucket</ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="bucket-name" className="text-sm font-medium text-zinc-700">
                Bucket name
              </label>
              <Input
                id="bucket-name"
                value={name}
                onChange={setName}
                placeholder="my-bucket-name"
                autoComplete="off"
              />
              <p className="text-xs text-zinc-500">Lowercase letters, numbers, and hyphens only.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="bucket-region" className="text-sm font-medium text-zinc-700">
                Region
              </label>
              {/* UNKNOWN: no custom Select component found — using native <select> styled to match Input */}
              <select
                id="bucket-region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                className="block w-full rounded-lg border border-zinc-200 p-3 text-zinc-900 focus:outline-2 focus:outline-brand-600"
              >
                <option value={S3_REGION}>{S3_REGION}</option>
                <option value="us-west-2">US West (Oregon)</option>
                <option value="eu-west-1">Europe (Ireland)</option>
              </select>
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="filled" onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating...' : 'Create bucket'}
            </Button>
          </div>
        </ModalFooter>
      </Modal>

      {/* ------------------------------------------------------------------ */}
      {/* Create Access Key Modal (shown after bucket creation) */}
      {/* ------------------------------------------------------------------ */}
      <CreateAccessKeyModal
        open={accessKeyOpen}
        onClose={() => setAccessKeyOpen(false)}
        onDone={() => setAccessKeyOpen(false)}
      />
    </div>
  );
}
