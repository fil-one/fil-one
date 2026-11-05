// Entry point of the Bucket Intelligence engine container.
//
//   node src/main.ts
//
// Configuration comes from the environment; see src/config.ts and README.md.

import { createAnswerProvider } from './answer.ts';
import { loadConfig } from './config.ts';
import { OpenAICompatibleEmbedder } from './embeddings.ts';
import { jsonLogger, type EngineContext } from './engine-context.ts';
import { createEngineServer } from './server.ts';
import { SyncManager } from './sync.ts';

const config = loadConfig();
const ctx: EngineContext = {
  config,
  embedder: new OpenAICompatibleEmbedder(config.embedding),
  answer: createAnswerProvider(config.answer),
  log: jsonLogger,
};
const syncs = new SyncManager(ctx);
const server = createEngineServer(ctx, syncs);

server.listen(config.port, () => {
  jsonLogger('info', 'listening', {
    port: config.port,
    embeddingModel: config.embedding.model,
    answerProvider: config.answer.provider,
    answerModel: ctx.answer?.model,
    s3EndpointOverrides: config.s3EndpointOverrides,
  });
});

function shutdown(signal: string): void {
  jsonLogger('info', 'shutdown', { signal });
  server.close(() => process.exit(0));
  // In-flight syncs are abandoned; the next sync resumes from the dataset.
  setTimeout(() => process.exit(0), 5_000).unref();
}

// Backstop: log and keep serving rather than exit on a stray rejection.
process.on('unhandledRejection', (reason) => {
  jsonLogger('error', 'unhandled_rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
