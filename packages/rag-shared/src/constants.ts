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
 * The default Bedrock model id used for grounded completions (the RAG query
 * endpoint, FIL-554). It is the Fil-One-managed default; callers may override it
 * per-request.
 *
 * Current-generation Claude models on Amazon Bedrock are invoked through a
 * cross-region inference profile (the `us.` prefix) rather than the bare
 * `foundation-model` id — on-demand throughput for these models is only
 * available through the profile. Callers' execution roles therefore need
 * `bedrock:InvokeModel` on both the inference-profile ARN and the underlying
 * foundation-model ARN.
 */
export const COMPLETION_MODEL_ID = 'us.anthropic.claude-opus-4-8';

/**
 * The Bedrock-flavored Anthropic Messages API version sent in the InvokeModel
 * request body. This is fixed by Bedrock and is distinct from the first-party
 * `anthropic-version` header.
 */
export const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

/**
 * Maximum number of tokens a grounded completion may generate. Bounded so a
 * single query cannot run away; well within Bedrock's per-response cap.
 */
export const COMPLETION_MAX_TOKENS = 1024;

/**
 * Maximum serialized size, in bytes, of the metadata attached to a single
 * vector. Amazon S3 Vectors rejects vectors whose metadata exceeds 40KB, so we
 * enforce it client-side to surface a clear error before the request is sent.
 */
export const MAX_METADATA_BYTES = 40 * 1024;

/**
 * Default target chunk size, in characters, used by the chunker (FIL-551) when
 * the caller does not override it.
 */
export const DEFAULT_CHUNK_SIZE = 1000;

/**
 * Default overlap, in characters, carried from the end of one chunk into the
 * start of the next so that context spanning a boundary is not lost.
 */
export const DEFAULT_OVERLAP_SIZE = 200;
