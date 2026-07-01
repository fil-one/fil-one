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
import type { S3Object, S3Region } from '@filone/shared';
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

/** Content type whose extraction is routed through Textract and needs PDF options. */
const PDF_CONTENT_TYPE = 'application/pdf';

/**
 * The core values that travel together through the whole bucket-indexing call
 * chain. Bundled into one object so each helper stays under the param limit and
 * the shared context is threaded explicitly rather than re-passed positionally.
 */
export interface BucketIndexContext {
  s3: S3Client;
  region: S3Region;
  bucketName: string;
  vectorStore: VectorStore;
}

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
  ctx: BucketIndexContext,
  options: IndexBucketOptions = {},
): Promise<IndexBucketResult> {
  const { s3, region, bucketName, vectorStore } = ctx;
  await vectorStore.ensureIndex(region, bucketName);

  // Mark the run in flight up front so the UI can show "Syncing…" immediately.
  // Writes only `syncState` (never the enablement `status`); atomic UpdateItem on
  // the enablement row, and a disabled-mid-run bucket is a no-op.
  await updateBucketTelemetry(region, bucketName, { syncState: 'syncing' });

  const manifest = await loadManifest(region, bucketName);
  const seen = new Set<string>();
  let indexSize = 0;
  const totals: PageOutcome = { added: 0, updated: 0, removed: 0, failed: 0 };

  const checkpoint = await loadCheckpoint(region, bucketName);
  let continuationToken = checkpoint?.continuationToken;
  // True only when this invocation walks the bucket from the very first page.
  // When we resume from a checkpoint, `seen` is necessarily incomplete, so we
  // must not treat unseen manifest entries as removed.
  const startedFromBeginning = continuationToken === undefined;

  while (true) {
    if (isPastDeadline(options.deadlineEpochMs)) {
      await saveCheckpoint(region, bucketName, continuationToken);
      console.log(`${LOG} Checkpointed mid-bucket (deadline reached)`, { region, bucketName });
      // Partial run: leave syncState as `syncing` (the next run finishes it) and
      // do not write the success snapshot, which is only valid for a full pass.
      return { ...totals, completed: false };
    }

    const page = await listObjects({ s3, bucket: bucketName, continuationToken });
    const outcome = await diffAndIndexPage(ctx, manifest, page);
    accumulate(totals, outcome);
    for (const object of page.objects) {
      seen.add(object.key);
      if (manifest.has(object.key)) indexSize += object.sizeBytes;
    }

    continuationToken = page.nextToken;
    if (!page.isTruncated || !continuationToken) break;

    // Persist progress after each page so a crash/timeout resumes here.
    await saveCheckpoint(region, bucketName, continuationToken);
  }

  // Only reconcile removals when `seen` is a complete enumeration of the bucket
  // (this invocation started from the first page and reached the last). On a
  // resumed run we skip this entirely to avoid deleting still-present objects
  // that were indexed in an earlier pass.
  if (startedFromBeginning) {
    const removed = await reconcileRemovals(ctx, manifest, seen);
    totals.removed += removed;
  } else {
    console.log(`${LOG} Skipping removal reconciliation on resumed run (partial enumeration)`, {
      region,
      bucketName,
    });
  }

  await clearCheckpoint(region, bucketName);

  // Persist the success telemetry snapshot only for a full pass (started from the
  // first page and reached the last): only then are the counts authoritative.
  // `filesIndexed` is the manifest size after reconciliation (objects with >=1
  // indexed chunk); `indexSize` sums the source-object bytes of those objects.
  if (startedFromBeginning) {
    await updateBucketTelemetry(region, bucketName, {
      syncState: 'idle',
      filesIndexed: manifest.size,
      indexSize,
      lastSyncedAt: new Date().toISOString(),
    });
  }

  console.log(`${LOG} Bucket reconciled`, { region, bucketName, ...totals });
  return { ...totals, completed: true };
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
  ctx: BucketIndexContext,
  manifest: Map<string, ManifestEntry>,
  page: { objects: S3Object[] },
): Promise<PageOutcome> {
  const outcome: PageOutcome = { added: 0, updated: 0, removed: 0, failed: 0 };

  for (const object of page.objects) {
    const action = await classifyAndIndexObject(ctx, manifest, object);
    if (action === 'added') outcome.added++;
    else if (action === 'updated') outcome.updated++;
    else if (action === 'removed') outcome.removed++;
    else if (action === 'failed') outcome.failed++;
  }

  return outcome;
}

type ObjectAction = 'added' | 'updated' | 'removed' | 'skipped' | 'failed';

/**
 * Classify a single listed object against the manifest and apply the minimal
 * vector-store mutation. New/changed objects are re-indexed (changed objects
 * have their stale chunks deleted first); unchanged objects are skipped. Never
 * throws — failures are logged and reported as `'failed'` so the page loop
 * keeps going.
 */
async function classifyAndIndexObject(
  ctx: BucketIndexContext,
  manifest: Map<string, ManifestEntry>,
  object: S3Object,
): Promise<ObjectAction> {
  const { region, bucketName, vectorStore } = ctx;
  const etag = object.etag;
  if (!etag) {
    console.warn(`${LOG} Object has no ETag, skipping`, { bucketName, key: object.key });
    return 'skipped';
  }

  const existing = manifest.get(object.key);
  // ETag is an opaque change token (multipart ETags are not MD5): equality only.
  if (existing && existing.etag === etag) return 'skipped';

  try {
    if (existing) {
      await vectorStore.deleteChunks(region, bucketName, existing.chunkKeys);
    }
    const chunkKeys = await indexObject(ctx, object.key, etag);
    if (!chunkKeys) {
      // A previously indexed object whose new version is no longer indexable:
      // its old chunks were just deleted above, so drop the manifest entry too
      // (persisted + in-memory) to keep the manifest authoritative and stop it
      // inflating filesIndexed/indexSize. A never-indexed object stays skipped.
      if (existing) {
        await deleteManifestEntry(region, bucketName, object.key);
        manifest.delete(object.key);
        return 'removed';
      }
      return 'skipped';
    }
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
      region,
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
  ctx: BucketIndexContext,
  objectKey: string,
  etag: string,
): Promise<string[] | null> {
  const { s3, region, bucketName, vectorStore } = ctx;
  const { bytes, contentType: storedType } = await getObjectBytes(s3, bucketName, objectKey);
  const contentType = resolveContentType(objectKey, storedType);
  if (!contentType) {
    console.warn(`${LOG} Unsupported content type, skipping`, {
      region,
      bucketName,
      key: objectKey,
    });
    return null;
  }

  const text = await extractText(
    bytes,
    contentType,
    contentType === PDF_CONTENT_TYPE
      ? { pdf: { documentLocation: { Bucket: bucketName, Name: objectKey } } }
      : {},
  );
  if (!text || text.trim().length === 0) {
    console.warn(`${LOG} No extractable text, skipping`, { region, bucketName, key: objectKey });
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

  await vectorStore.upsertChunks(region, bucketName, chunks);
  const chunkKeys = chunks.map((c) => c.key);
  await saveManifestEntry(region, bucketName, { objectKey, etag, chunkKeys });
  return chunkKeys;
}

/**
 * Delete the vectors and manifest rows of every object that is in the manifest
 * but was not seen in the listing — i.e. removed from S3 since the last run.
 * Returns the number of objects removed. Failures are isolated per object.
 */
async function reconcileRemovals(
  ctx: BucketIndexContext,
  manifest: Map<string, ManifestEntry>,
  seen: Set<string>,
): Promise<number> {
  const { region, bucketName, vectorStore } = ctx;
  let removed = 0;
  for (const [objectKey, entry] of manifest) {
    if (seen.has(objectKey)) continue;
    try {
      await vectorStore.deleteChunks(region, bucketName, entry.chunkKeys);
      await deleteManifestEntry(region, bucketName, objectKey);
      // Drop from the in-memory manifest so the telemetry snapshot
      // (`filesIndexed` = manifest size) no longer counts the removed object.
      manifest.delete(objectKey);
      removed++;
    } catch (error) {
      console.error(`${LOG} Failed to remove object`, {
        region,
        bucketName,
        key: objectKey,
        error,
      });
    }
  }
  return removed;
}
