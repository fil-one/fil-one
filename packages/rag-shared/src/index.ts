export {
  BEDROCK_ANTHROPIC_VERSION,
  COMPLETION_MAX_TOKENS,
  COMPLETION_MODEL_ID,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_OVERLAP_SIZE,
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL_ID,
  MAX_METADATA_BYTES,
} from './constants.ts';

export { embed, embedMany } from './embed.ts';

export { complete } from './complete.ts';
export type { CompleteOptions } from './complete.ts';

export { chunk } from './chunker.ts';
export type { ChunkingOptions } from './chunker.ts';

export { extractText } from './extractor.ts';

export { extractTextFromPdf } from './pdf-extractor.ts';

export { S3VectorsStore } from './s3-vectors-store.ts';

export type { EnsureIndexOptions, VectorStore } from './vector-store.ts';

export { VectorQueryResultSchema, VectorStoreChunkSchema } from './schemas.ts';
export type { VectorQueryResult, VectorStoreChunk } from './schemas.ts';
