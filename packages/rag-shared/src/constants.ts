/**
 * The dimensionality of the embedding vectors produced by the embeddings
 * module (FIL-552) and stored by the vector store (FIL-548).
 *
 * This value MUST match:
 *   - the `dimensions` parameter sent to Bedrock Titan (`embed`)
 *   - the `dimension` configured on each S3 Vectors index (`ensureIndex`)
 *
 * Amazon Titan Text Embeddings V2 supports 256, 512, or 1024 dimensions; we
 * fix it at 1024 (the model default) for maximum retrieval quality.
 */
export const EMBEDDING_DIMENSION = 1024;

/**
 * The Bedrock model id used for embeddings.
 */
export const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';

/**
 * Maximum serialized size, in bytes, of the metadata attached to a single
 * vector. Amazon S3 Vectors rejects vectors whose metadata exceeds 40KB, so we
 * enforce it client-side to surface a clear error before the request is sent.
 */
export const MAX_METADATA_BYTES = 40 * 1024;
