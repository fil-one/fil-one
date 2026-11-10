import type { EmbeddingConfig } from './config.ts';

/** Turns text into vectors. One instance serves every tenant. */
export interface Embedder {
  readonly model: string;
  /** One vector per input, in input order. */
  embed(texts: string[]): Promise<number[][]>;
}

interface EmbeddingsResponse {
  data?: { index?: number; embedding?: unknown }[];
}

function toVector(value: unknown, index: number): number[] {
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== 'number') {
    throw new Error(`Embedding response item ${index} has no vector`);
  }
  return value as number[];
}

/**
 * Client for an OpenAI-compatible `POST /embeddings` endpoint, such as
 * Hugging Face text-embeddings-inference. Inputs are sent in batches of
 * `batchSize`, one request at a time.
 */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly model: string;
  readonly #config: EmbeddingConfig;
  readonly #fetch: typeof fetch;

  constructor(config: EmbeddingConfig, fetchImpl: typeof fetch = fetch) {
    this.model = config.model;
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.#config.batchSize) {
      out.push(...(await this.#embedBatch(texts.slice(i, i + this.#config.batchSize))));
    }
    return out;
  }

  async #embedBatch(input: string[]): Promise<number[][]> {
    const url = `${this.#config.baseUrl.replace(/\/+$/, '')}/embeddings`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.#config.apiKey) headers.Authorization = `Bearer ${this.#config.apiKey}`;

    const response = await this.#fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model, input }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Embedding request failed with HTTP ${response.status}: ${detail}`);
    }
    const body = (await response.json()) as EmbeddingsResponse;
    const items = body.data ?? [];
    if (items.length !== input.length) {
      throw new Error(`Embedding response has ${items.length} vectors for ${input.length} inputs`);
    }
    // The spec returns items with an index; order by it rather than trusting
    // response order.
    return [...items]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item, i) => toVector(item.embedding, i));
  }
}
