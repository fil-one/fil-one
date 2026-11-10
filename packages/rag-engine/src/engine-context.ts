import type { AnswerProvider } from './answer.ts';
import type { EngineConfig } from './config.ts';
import type { Embedder } from './embeddings.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured log line. Callers never pass credentials or tenant keys. */
export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export const jsonLogger: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

/** Everything a request handler needs. Built once at startup. */
export interface EngineContext {
  config: EngineConfig;
  embedder: Embedder;
  answer?: AnswerProvider;
  log: Logger;
}
