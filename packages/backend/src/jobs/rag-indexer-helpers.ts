// Core of the RAG indexer: reconcile one bucket's vector index with its S3
// contents using object-level ETag diffing against the chunk manifest.
//
// Pages objects via listObjects (no HeadObject — the ETag comes straight from
// the listing). For each page it classifies every object as new / changed /
// unchanged / removed and applies the minimal vector-store mutation, isolating
// per-object failures so one bad object never aborts the bucket. Progress is
// checkpointed after every page so a worker that runs out of time resumes
// mid-bucket on the next run.

import type { S3Client } from '@aws-sdk/client-s3';
import type { S3Object } from '@filone/shared';
import {
  chunk,
  embedMany,
  extractText,
  type VectorStore,
  type VectorStoreChunk,
} from '@filone/rag-shared';
import { getObjectBytes, listObjects } from '../lib/s3-bucket-operations.js';
import { updateBucketTelemetry } from '../lib/bucket-rag-enablement.js';
import { resolveContentType } from './rag-content-type.js';
import {
  clearCheckpoint,
  deleteManifestEntry,
  loadCheckpoint,
  loadManifest,
  saveCheckpoint,
  saveManifestEntry,
  type ManifestEntry,
} from './rag-indexer-manifest.js';

const LOG = '[rag-indexer-helpers]';

export interface IndexBucketResult {
  added: number;
  updated: number;
  removed: number;
  failed: number;
  /** True when the bucket was fully reconciled this run; false when it was checkpointed mid-way. */
  completed: boolean;
}

export interface IndexBucketOptions {
  /** Epoch ms after which the worker stops starting new pages and checkpoints. */
  deadlineEpochMs?: number;
}

interface PageOutcome {
  added: number;
  updated: number;
  removed: number;
  failed: number;
}

/**
 * Reconcile `bucketName`'s vector index with its S3 contents.
 *
 * Resumes from a persisted checkpoint when one exists. Walks the listing page
 * by page, indexing additions/changes and tracking which manifest objects were
 * seen; once the listing is exhausted, any manifest object never seen is
 * treated as removed and deleted. Stops early (checkpointing the continuation
 * token) when `deadlineEpochMs` passes, so the next run continues the walk.
 *
 * Removal reconciliation (deleting manifest entries / chunks for objects no
 * longer in S3) is data-destructive, so it must only ever run against a
 * COMPLETE enumeration of the bucket. We use approach (b): removals are only
 * reconciled when this single invocation enumerated the bucket from the very
 * start (no resumed continuation token) all the way to the last page. On a
 * resumed/partial run `seen` holds only the keys observed in this invocation's
 * pages, so we deliberately SKIP removal reconciliation — otherwise objects
 * indexed in an earlier (checkpointed) run would be wrongly deleted even though
 * they still exist in S3. A later non-resumed full pass reconciles removals.
 *
 * (Approach (b) is preferred over accumulating the seen-key set in the
 * checkpoint because that set is unbounded for large buckets and a DynamoDB
 * item is capped at 400 KB; (b) needs no extra persisted state and is always
 * correct.)
 */
export async function indexBucket(
  s3: S3Client,
  bucketId: string,
  bucketName: string,
  vectorStore: VectorStore,
  options: IndexBucketOptions = {},
): Promise<IndexBucketResult> {
  // Mark the run in flight up front so the UI can show "Syncing…" immediately.
  // Writes only `syncState` (never the enablement `status`); atomic UpdateItem on
  // the enablement row, and a disabled-mid-run bucket is a no-op.
  await updateBucketTelemetry(bucketName, { syncState: 'syncing' });

  await vectorStore.ensureIndex(bucketName);

  const manifest = await loadManifest(bucketId);
  const seen = new Set<string>();
  // Source-object byte sizes observed this run, keyed by object key. Used to
  // compute `indexSize` (sum of indexed source-object bytes) at completion.
  const sizes = new Map<string, number>();
  const totals: PageOutcome = { added: 0, updated: 0, removed: 0, failed: 0 };

  const checkpoint = await loadCheckpoint(bucketId);
  let continuationToken = checkpoint?.continuationToken;
  // True only when this invocation walks the bucket from the very first page.
  // When we resume from a checkpoint, `seen` is necessarily incomplete, so we
  // must not treat unseen manifest entries as removed.
  const startedFromBeginning = continuationToken === undefined;

  for (;;) {
    if (isPastDeadline(options.deadlineEpochMs)) {
      await saveCheckpoint(bucketId, bucketName, continuationToken);
      console.log(`${LOG} Checkpointed mid-bucket (deadline reached)`, { bucketId, bucketName });
      // Partial run: leave syncState as `syncing` (the next run finishes it) and
      // do not write the success snapshot, which is only valid for a full pass.
      return { ...totals, completed: false };
    }

    const page = await listObjects({ s3, bucket: bucketName, continuationToken });
    const outcome = await diffAndIndexPage(s3, bucketName, bucketId, vectorStore, manifest, page);
    accumulate(totals, outcome);
    for (const object of page.objects) {
      seen.add(object.key);
      sizes.set(object.key, object.sizeBytes);
    }

    continuationToken = page.nextToken;
    if (!page.isTruncated || !continuationToken) break;

    // Persist progress after each page so a crash/timeout resumes here.
    await saveCheckpoint(bucketId, bucketName, continuationToken);
  }

  // Only reconcile removals when `seen` is a complete enumeration of the bucket
  // (this invocation started from the first page and reached the last). On a
  // resumed run we skip this entirely to avoid deleting still-present objects
  // that were indexed in an earlier pass.
  if (startedFromBeginning) {
    const removed = await reconcileRemovals(bucketId, bucketName, vectorStore, manifest, seen);
    totals.removed += removed;
  } else {
    console.log(`${LOG} Skipping removal reconciliation on resumed run (partial enumeration)`, {
      bucketId,
      bucketName,
    });
  }

  await clearCheckpoint(bucketId);

  // Persist the success telemetry snapshot only for a full pass (started from the
  // first page and reached the last): only then are the counts authoritative.
  // `filesIndexed` is the manifest size after reconciliation (objects with >=1
  // indexed chunk); `indexSize` sums the source-object bytes of those objects.
  if (startedFromBeginning) {
    await updateBucketTelemetry(bucketName, {
      syncState: 'idle',
      filesIndexed: manifest.size,
      indexSize: sumIndexedBytes(manifest, sizes),
      lastSyncedAt: new Date().toISOString(),
    });
  }

  console.log(`${LOG} Bucket reconciled`, { bucketId, bucketName, ...totals });
  return { ...totals, completed: true };
}

/**
 * Sum the source-object bytes of every object still in the manifest (i.e. with
 * at least one indexed chunk), using the sizes observed in this run's listing.
 * An object in the manifest but absent from `sizes` (defensive: not seen this
 * run) contributes 0 rather than throwing.
 */
function sumIndexedBytes(manifest: Map<string, ManifestEntry>, sizes: Map<string, number>): number {
  let total = 0;
  for (const objectKey of manifest.keys()) {
    total += sizes.get(objectKey) ?? 0;
  }
  return total;
}

function isPastDeadline(deadlineEpochMs: number | undefined): boolean {
  return typeof deadlineEpochMs === 'number' && Date.now() >= deadlineEpochMs;
}

function accumulate(totals: PageOutcome, page: PageOutcome): void {
  totals.added += page.added;
  totals.updated += page.updated;
  totals.removed += page.removed;
  totals.failed += page.failed;
}

/**
 * Classify and index one page of objects against the manifest. Per object:
 *   - absent from manifest         -> new: extract + chunk + embed + upsert
 *   - present, different ETag       -> changed: delete old chunks + re-index
 *   - present, same ETag            -> unchanged: skip (no embed/upsert)
 * Removals are handled once after the full listing (see reconcileRemovals).
 * Each object is isolated: a failure is logged and counted, never thrown.
 */
export async function diffAndIndexPage(
  s3: S3Client,
  bucketName: string,
  bucketId: string,
  vectorStore: VectorStore,
  manifest: Map<string, ManifestEntry>,
  page: { objects: S3Object[] },
): Promise<PageOutcome> {
  const outcome: PageOutcome = { added: 0, updated: 0, removed: 0, failed: 0 };

  for (const object of page.objects) {
    const action = await classifyAndIndexObject(
      s3,
      bucketName,
      bucketId,
      vectorStore,
      manifest,
      object,
    );
    if (action === 'added') outcome.added++;
    else if (action === 'updated') outcome.updated++;
    else if (action === 'failed') outcome.failed++;
  }

  return outcome;
}

type ObjectAction = 'added' | 'updated' | 'skipped' | 'failed';

/**
 * Classify a single listed object against the manifest and apply the minimal
 * vector-store mutation. New/changed objects are re-indexed (changed objects
 * have their stale chunks deleted first); unchanged objects are skipped. Never
 * throws — failures are logged and reported as `'failed'` so the page loop
 * keeps going.
 */
async function classifyAndIndexObject(
  s3: S3Client,
  bucketName: string,
  bucketId: string,
  vectorStore: VectorStore,
  manifest: Map<string, ManifestEntry>,
  object: S3Object,
): Promise<ObjectAction> {
  const etag = object.etag;
  if (!etag) {
    console.warn(`${LOG} Object has no ETag, skipping`, { bucketId, key: object.key });
    return 'skipped';
  }

  const existing = manifest.get(object.key);
  // ETag is an opaque change token (multipart ETags are not MD5): equality only.
  if (existing && existing.etag === etag) return 'skipped';

  try {
    if (existing) {
      await vectorStore.deleteChunks(bucketName, existing.chunkKeys);
    }
    const chunkKeys = await indexObject(s3, bucketName, bucketId, vectorStore, object.key, etag);
    if (!chunkKeys) return 'skipped';
    // Keep the in-memory manifest authoritative so the post-run telemetry
    // snapshot (`filesIndexed` = manifest size) reflects this object too.
    manifest.set(object.key, {
      objectKey: object.key,
      etag,
      chunkKeys,
      updatedAt: new Date().toISOString(),
    });
    return existing ? 'updated' : 'added';
  } catch (error) {
    console.error(`${LOG} Failed to index object`, {
      bucketId,
      bucketName,
      key: object.key,
      error,
    });
    return 'failed';
  }
}

/**
 * Extract, chunk, embed and upsert one object, then record its manifest entry.
 * Returns the object's chunk keys on success, or `null` (without throwing) for
 * objects with no extractable content type or no text — those are not indexed.
 */
async function indexObject(
  s3: S3Client,
  bucketName: string,
  bucketId: string,
  vectorStore: VectorStore,
  objectKey: string,
  etag: string,
): Promise<string[] | null> {
  const { bytes, contentType: storedType } = await getObjectBytes(s3, bucketName, objectKey);
  const contentType = resolveContentType(objectKey, storedType);
  if (!contentType) {
    console.warn(`${LOG} Unsupported content type, skipping`, { bucketId, key: objectKey });
    return null;
  }

  const text = await extractText(bytes, contentType);
  if (!text || text.trim().length === 0) {
    console.warn(`${LOG} No extractable text, skipping`, { bucketId, key: objectKey });
    return null;
  }

  const texts = chunk(text);
  const embeddings = await embedMany(texts);
  const chunks: VectorStoreChunk[] = texts.map((chunkText, index) => ({
    key: `${objectKey}#${index}`,
    text: chunkText,
    metadata: { objectKey },
    embedding: embeddings[index],
  }));

  await vectorStore.upsertChunks(bucketName, chunks);
  const chunkKeys = chunks.map((c) => c.key);
  await saveManifestEntry(bucketId, objectKey, etag, chunkKeys);
  return chunkKeys;
}

/**
 * Delete the vectors and manifest rows of every object that is in the manifest
 * but was not seen in the listing — i.e. removed from S3 since the last run.
 * Returns the number of objects removed. Failures are isolated per object.
 */
async function reconcileRemovals(
  bucketId: string,
  bucketName: string,
  vectorStore: VectorStore,
  manifest: Map<string, ManifestEntry>,
  seen: Set<string>,
): Promise<number> {
  let removed = 0;
  for (const [objectKey, entry] of manifest) {
    if (seen.has(objectKey)) continue;
    try {
      await vectorStore.deleteChunks(bucketName, entry.chunkKeys);
      await deleteManifestEntry(bucketId, objectKey);
      // Drop from the in-memory manifest so the telemetry snapshot
      // (`filesIndexed` = manifest size) no longer counts the removed object.
      manifest.delete(objectKey);
      removed++;
    } catch (error) {
      console.error(`${LOG} Failed to remove object`, {
        bucketId,
        bucketName,
        key: objectKey,
        error,
      });
    }
  }
  return removed;
}
