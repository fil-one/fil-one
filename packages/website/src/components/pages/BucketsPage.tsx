import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { PlusIcon, DatabaseIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from '@hyperspace/ui/Button';
import { Input } from '@hyperspace/ui/Input';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@hyperspace/ui/Modal';
import { CodeBlock } from '@hyperspace/ui/CodeBlock';
import { Spinner } from '@hyperspace/ui/Spinner';
import { useToast } from '@hyperspace/ui/Toast';

import type {
  Bucket,
  CreateBucketRequest,
  CreateBucketResponse,
  ListBucketsResponse,
} from '@hyperspace/shared';
import { apiRequest } from '../../lib/api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

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
  const [region, setRegion] = useState('us-east-1');

  // Save credentials modal state
  const [credsOpen, setCredsOpen] = useState(false);

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
      setRegion('us-east-1');
      toast.success('Bucket created successfully');
      setCredsOpen(true);
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
                  Objects
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Size
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
                  <td className="px-4 py-3 text-zinc-600">{bucket.objectCount.toLocaleString()}</td>
                  <td className="px-4 py-3 text-zinc-600">{formatBytes(bucket.sizeBytes)}</td>
                  <td className="px-4 py-3 text-zinc-600">
                    {new Date(bucket.createdAt).toLocaleDateString()}
                  </td>
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
                <option value="us-east-1">US East (N. Virginia)</option>
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
      {/* Save Credentials Modal */}
      {/* ------------------------------------------------------------------ */}
      <Modal open={credsOpen} onClose={() => setCredsOpen(false)} size="md">
        <ModalHeader onClose={() => setCredsOpen(false)}>Save your credentials</ModalHeader>
        <ModalBody>
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            ⚠️ Make sure to copy your access key now. You won&apos;t be able to see it again.
          </div>
          <div className="flex flex-col gap-3">
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
                Access Key ID
              </p>
              <CodeBlock code="HKIAXXXXXXXXXXXXXXXXXXX" />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
                Secret Access Key
              </p>
              <CodeBlock code="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" />
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <div className="flex justify-end">
            <Button variant="filled" onClick={() => setCredsOpen(false)}>
              I&apos;ve saved my credentials
            </Button>
          </div>
        </ModalFooter>
      </Modal>
    </div>
  );
}
