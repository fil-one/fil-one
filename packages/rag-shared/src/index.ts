export {
  BEDROCK_ANTHROPIC_VERSION,
  COMPLETION_MAX_TOKENS,
  COMPLETION_MODEL_ID,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_OVERLAP_SIZE,
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL_ID,
  MAX_METADATA_BYTES,
} from './constants.js';

export { embed, embedMany } from './embed.js';

export { complete } from './complete.js';
export type { CompleteOptions } from './complete.js';

export { chunk } from './chunker.js';
export type { ChunkingOptions } from './chunker.js';

export { extractText } from './extractor.js';

export { extractTextFromPdf } from './pdf-extractor.js';

export { BucketObjectVectorStore, companionBucketName } from './bucket-object-vector-store.js';
export type { BucketObjectVectorStoreOptions } from './bucket-object-vector-store.js';

// SPIKE — an alternative backend for the same companion buckets, not yet wired
// into the indexer or the query path. See
// docs/architectural-decisions/rag-vector-store-options.md.
export { LanceVectorStore } from './lance-vector-store.js';
export type { LanceStorageContext, LanceVectorStoreOptions } from './lance-vector-store.js';

export type { EnsureIndexOptions, QueryOptions, VectorStore } from './vector-store.js';

export { VectorQueryResultSchema, VectorStoreChunkSchema } from './schemas.js';
export type { VectorQueryResult, VectorStoreChunk } from './schemas.js';
