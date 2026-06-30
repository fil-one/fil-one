import { z } from 'zod';

/**
 * A single chunk to be written to the vector store. The `key` uniquely
 * identifies the chunk within an index and is, by convention,
 * `${objectKey}#${chunkIndex}`.
 */
export const VectorStoreChunkSchema = z.object({
  key: z.string(),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  embedding: z.number().array().optional(),
});

export type VectorStoreChunk = z.infer<typeof VectorStoreChunkSchema>;

/**
 * A single result returned from a k-NN query against the vector store.
 */
export const VectorQueryResultSchema = z.object({
  key: z.string(),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  score: z.number(),
});

export type VectorQueryResult = z.infer<typeof VectorQueryResultSchema>;
