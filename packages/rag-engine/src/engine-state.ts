import type { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

import { STATE_KEY, readJsonObject, writeJsonObject } from './storage.ts';

/**
 * The small JSON object kept next to the dataset (`lance/engine-state.json`).
 * It lets a restarted engine report when the last sync finished, notice an
 * embedding model change, and avoid re-reading objects it could not index.
 */
export const EngineStateSchema = z.object({
  lastSyncedAt: z.string().optional(),
  embedding: z.object({ model: z.string(), dimension: z.number().int() }).optional(),
  /** Objects that produced no chunks, keyed by object key, valued by the ETag tried. */
  skipped: z.record(z.string(), z.string()).default({}),
});
export type EngineState = z.infer<typeof EngineStateSchema>;

export async function readEngineState(s3: S3Client, companionBucket: string): Promise<EngineState> {
  const raw = await readJsonObject(s3, companionBucket, STATE_KEY);
  const parsed = EngineStateSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { skipped: {} };
}

export async function writeEngineState(
  s3: S3Client,
  companionBucket: string,
  state: EngineState,
): Promise<void> {
  await writeJsonObject(s3, companionBucket, STATE_KEY, state);
}
