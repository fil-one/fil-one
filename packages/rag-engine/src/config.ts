/**
 * Engine configuration, read once from the environment at startup.
 *
 * Secrets (the engine token and model API keys) come from the environment and
 * are never logged.
 */

import type { EndpointOverrides } from './storage.ts';

export type AnswerConfig =
  | { provider: 'anthropic'; apiKey: string; model: string }
  | {
      provider: 'openai-compatible';
      baseUrl: string;
      model: string;
      apiKey?: string;
    }
  | { provider: 'none' };

export interface EmbeddingConfig {
  /** Base URL of an OpenAI-compatible API, e.g. `http://tei/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Inputs per `/embeddings` request. */
  batchSize: number;
}

export interface EngineConfig {
  port: number;
  /** Bearer token every `/v1/*` request must carry. */
  token: string;
  /**
   * Per-region replacements for the endpoint the console passes in
   * `target.s3`, e.g. the appliance's loopback address for its own Ingot.
   * SigV4 signs the host actually contacted, so the tenant key still
   * verifies. Regions not listed use the console's endpoint.
   */
  s3EndpointOverrides: EndpointOverrides;
  embedding: EmbeddingConfig;
  answer: AnswerConfig;
  /** Rows at which a sync builds the ANN vector index; below it, search is a flat scan. */
  vectorIndexMinRows: number;
  /** Chunks buffered before one Lance commit during a sync. */
  flushRows: number;
  /** Source objects larger than this are skipped. */
  maxObjectBytes: number;
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-small-en-v1.5';

type Env = Record<string, string | undefined>;

function intFrom(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function answerConfig(env: Env): AnswerConfig {
  const anthropicKey = optional(env, 'ANTHROPIC_API_KEY');
  const provider = optional(env, 'ANSWER_PROVIDER') ?? (anthropicKey ? 'anthropic' : 'none');
  switch (provider) {
    case 'anthropic':
      if (!anthropicKey) throw new Error('ANSWER_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
      return {
        provider,
        apiKey: anthropicKey,
        model: optional(env, 'ANSWER_MODEL') ?? DEFAULT_ANTHROPIC_MODEL,
      };
    case 'openai-compatible': {
      const baseUrl = optional(env, 'ANSWER_BASE_URL');
      const model = optional(env, 'ANSWER_MODEL');
      if (!baseUrl || !model) {
        throw new Error('ANSWER_PROVIDER=openai-compatible needs ANSWER_BASE_URL and ANSWER_MODEL');
      }
      return {
        provider,
        baseUrl,
        model,
        apiKey: optional(env, 'ANSWER_API_KEY'),
      };
    }
    case 'none':
      return { provider };
    default:
      throw new Error(`Unknown ANSWER_PROVIDER "${provider}"`);
  }
}

/**
 * Parse `ENGINE_S3_ENDPOINT_OVERRIDE`: comma-separated `region=url` pairs,
 * e.g. `eu-central-3=http://127.0.0.1:15200`. `*=url` overrides every region
 * and suits a local engine that talks to a single Ingot. A bare URL is
 * refused: on a stage with several Forge regions it would send all of them to
 * one gateway.
 */
export function parseEndpointOverrides(raw: string | undefined): EndpointOverrides {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const entry of raw.split(',')) {
    const pair = entry.trim();
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const region = eq > 0 ? pair.slice(0, eq).trim() : '';
    const url = eq > 0 ? pair.slice(eq + 1).trim() : '';
    if (!region || !/^https?:\/\//.test(url)) {
      throw new Error(
        `ENGINE_S3_ENDPOINT_OVERRIDE entries must be region=http(s)://host:port, got "${pair}"`,
      );
    }
    out[region] = url;
  }
  return out;
}

export function loadConfig(env: Env = process.env): EngineConfig {
  const token = optional(env, 'ENGINE_TOKEN');
  if (!token) throw new Error('ENGINE_TOKEN is required');
  const embeddingBaseUrl = optional(env, 'EMBEDDING_BASE_URL');
  if (!embeddingBaseUrl) throw new Error('EMBEDDING_BASE_URL is required');

  return {
    port: intFrom(env, 'ENGINE_PORT', 8080),
    token,
    s3EndpointOverrides: parseEndpointOverrides(optional(env, 'ENGINE_S3_ENDPOINT_OVERRIDE')),
    embedding: {
      baseUrl: embeddingBaseUrl,
      model: optional(env, 'EMBEDDING_MODEL') ?? DEFAULT_EMBEDDING_MODEL,
      apiKey: optional(env, 'EMBEDDING_API_KEY'),
      batchSize: intFrom(env, 'EMBEDDING_BATCH_SIZE', 32),
    },
    answer: answerConfig(env),
    vectorIndexMinRows: intFrom(env, 'ENGINE_VECTOR_INDEX_MIN_ROWS', 256),
    flushRows: intFrom(env, 'ENGINE_FLUSH_ROWS', 1500),
    maxObjectBytes: intFrom(env, 'ENGINE_MAX_OBJECT_BYTES', 64 * 1024 * 1024),
  };
}
