// Test harness: an engine on a random port in front of an in-process S3
// server, with a deterministic embedder and an optional fake answer provider.

import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { RagEngineStatus, RagEngineTarget } from '@filone/shared';

import type { AnswerPassage, AnswerProvider } from '../answer.ts';
import type { EngineConfig } from '../config.ts';
import type { Embedder } from '../embeddings.ts';
import type { EngineContext } from '../engine-context.ts';
import { createEngineServer } from '../server.ts';
import { SyncManager } from '../sync.ts';
import {
  startTestS3Server,
  type TestS3Server,
  type TestS3ServerOptions,
} from './test-s3-server.ts';

export const TOKEN = 'test-engine-token';
export const SOURCE_BUCKET = 'docs';
export const DIMENSION = 64;

/**
 * Hashed bag of words: texts sharing words get close vectors, so vector search
 * behaves sensibly without a model.
 */
export class FakeEmbedder implements Embedder {
  /** Writable so a test can stand in for an operator changing `EMBEDDING_MODEL`. */
  model = 'fake-bow-64';
  calls = 0;
  /** Delay per call, to keep a sync running while a test looks at it. */
  delayMs = 0;
  /** When set, the call with this number (1-based) fails. */
  failOnCall: number | undefined;

  /** Runs at the start of every call, with the call number (1-based). */
  onCall: ((call: number) => void) | undefined;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    this.onCall?.(this.calls);
    if (this.calls === this.failOnCall) throw new Error('embedding service unavailable');
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return texts.map((text) => FakeEmbedder.vector(text));
  }

  static vector(text: string): number[] {
    const v = new Array<number>(DIMENSION).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % DIMENSION]! += 1;
    }
    const norm = Math.hypot(...v);
    if (norm === 0) return v.map((_, i) => (i === 0 ? 1 : 0));
    return v.map((x) => x / norm);
  }
}

export class FakeAnswerProvider implements AnswerProvider {
  readonly model = 'fake-answer';
  readonly questions: { question: string; passages: AnswerPassage[] }[] = [];
  /** When set, `answer` rejects with this error. */
  failWith: Error | undefined;
  /** `'until-aborted'` waits for the engine's abort; `'forever'` ignores it. */
  hang: 'until-aborted' | 'forever' | undefined;
  /** The signal each call received. */
  readonly signals: (AbortSignal | undefined)[] = [];
  /** When set, `answer` resolves with this text. */
  reply: string | undefined;

  answer(question: string, passages: AnswerPassage[], signal?: AbortSignal): Promise<string> {
    this.questions.push({ question, passages });
    this.signals.push(signal);
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.hang === 'forever') return new Promise(() => {});
    if (this.hang === 'until-aborted') {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    if (this.reply !== undefined) return Promise.resolve(this.reply);
    return Promise.resolve(`Answer citing [1] from ${passages[0]?.objectKey ?? 'nothing'}`);
  }
}

export interface Harness {
  s3: TestS3Server;
  root: string;
  url: string;
  target: RagEngineTarget;
  embedder: FakeEmbedder;
  answer: FakeAnswerProvider;
  syncs: SyncManager;
  /** Every line the engine logged. */
  logs: { level: string; event: string; fields?: Record<string, unknown> }[];
  putSource(key: string, body: string | Uint8Array): void;
  deleteSource(key: string): void;
  call<T = ErrorResponse>(
    route: string,
    body: unknown,
    token?: string,
  ): Promise<{ status: number; body: T }>;
  syncAndWait(): Promise<RagEngineStatus>;
  close(): Promise<void>;
}

/** Shape of an engine error response, the default for {@link Harness.call}. */
export interface ErrorResponse {
  error: { code: string; message: string };
}

export interface HarnessOptions {
  config?: Partial<EngineConfig>;
  s3?: Omit<TestS3ServerOptions, 'root'>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-engine-'));
  const s3 = await startTestS3Server({
    root,
    accessKeyId: 'AKTEST',
    ...options.s3,
  });
  fs.mkdirSync(path.join(root, SOURCE_BUCKET));

  const embedder = new FakeEmbedder();
  const answer = new FakeAnswerProvider();
  const logs: Harness['logs'] = [];
  const ctx: EngineContext = {
    config: {
      port: 0,
      token: TOKEN,
      embedding: {
        baseUrl: 'http://unused',
        model: embedder.model,
        batchSize: 32,
      },
      answer: { provider: 'none' },
      vectorIndexMinRows: 1_000_000,
      flushRows: 1500,
      maxObjectBytes: 1024 * 1024,
      maxChunksPerObject: 4000,
      ...options.config,
      s3EndpointOverrides: options.config?.s3EndpointOverrides ?? {},
    },
    embedder,
    answer,
    log: (level, event, fields) => {
      logs.push({ level, event, fields });
    },
  };
  const syncs = new SyncManager(ctx);
  const server: http.Server = createEngineServer(ctx, syncs);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const url = `http://127.0.0.1:${address.port}`;

  const target: RagEngineTarget = {
    orgId: 'org-1',
    region: 'us-east-9',
    bucketName: SOURCE_BUCKET,
    s3: {
      endpointUrl: s3.url,
      region: 'us-east-9',
      accessKeyId: 'AKTEST',
      secretAccessKey: 'SK',
    },
  };

  const call = async <T>(route: string, body: unknown, token = TOKEN) => {
    const response = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  };

  return {
    s3,
    root,
    url,
    target,
    embedder,
    answer,
    syncs,
    logs,
    putSource(key, body) {
      const file = path.join(root, SOURCE_BUCKET, key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    },
    deleteSource(key) {
      fs.rmSync(path.join(root, SOURCE_BUCKET, key));
    },
    call,
    async syncAndWait() {
      const started = await call<RagEngineStatus>('/v1/sync', { target });
      if (started.status !== 202) throw new Error(`sync returned ${started.status}`);
      await syncs.idle();
      return (await call<RagEngineStatus>('/v1/status', { target })).body;
    },
    async close() {
      await syncs.idle();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await s3.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
