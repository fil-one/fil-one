import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

import { EMBEDDING_DIMENSION, EMBEDDING_MODEL_ID } from './constants.js';

/**
 * The shape Amazon Titan Text Embeddings V2 returns in its response body.
 */
interface TitanEmbeddingResponse {
  embedding?: unknown;
}

/**
 * Turn a single string into a vector embedding via Amazon Bedrock Titan.
 *
 * Titan v2 embeds exactly one string per call (no batch input); use
 * {@link embedMany} when embedding several texts. Callers' execution roles need
 * `bedrock:InvokeModel` on the Titan model.
 *
 * @throws if `text` is empty/whitespace, if Bedrock fails, or if the returned
 *   vector length does not equal {@link EMBEDDING_DIMENSION}.
 */
export async function embed(text: string, client?: BedrockRuntimeClient): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    throw new Error('Text to embed cannot be empty');
  }

  const bedrock = client ?? new BedrockRuntimeClient({});
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(
        JSON.stringify({
          inputText: text,
          dimensions: EMBEDDING_DIMENSION,
          normalize: true,
        }),
      ),
    }),
  );

  if (!response.body) {
    throw new Error('Bedrock returned an empty response body');
  }

  const parsed = JSON.parse(new TextDecoder().decode(response.body)) as TitanEmbeddingResponse;
  const embedding = parsed.embedding;

  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSION) {
    const got = Array.isArray(embedding) ? embedding.length : 'none';
    throw new Error(`Embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, got ${got}`);
  }

  return embedding as number[];
}

/**
 * Embed several texts. Titan v2 has no batch endpoint, so this fans out to
 * {@link embed} once per text (a convenience for indexers).
 */
export async function embedMany(
  texts: string[],
  client?: BedrockRuntimeClient,
): Promise<number[][]> {
  return Promise.all(texts.map((text) => embed(text, client)));
}
