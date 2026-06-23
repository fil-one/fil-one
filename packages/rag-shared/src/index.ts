export { EMBEDDING_DIMENSION, EMBEDDING_MODEL_ID, MAX_METADATA_BYTES } from './constants.js';

export { embed, embedMany } from './embed.js';

export { S3VectorsStore } from './s3-vectors-store.js';

export type { EnsureIndexOptions, VectorStore } from './vector-store.js';

export { VectorQueryResultSchema, VectorStoreChunkSchema } from './schemas.js';
export type { VectorQueryResult, VectorStoreChunk } from './schemas.js';
