import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-node';
import { getTracer, flushTraces } from './tracer.js';

describe('tracer', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  beforeAll(() => {
    provider.register();
  });

  beforeEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });

  describe('getTracer', () => {
    it('returns a tracer with the default name', () => {
      const tracer = getTracer();
      tracer.startActiveSpan('test-span', (span) => {
        span.end();
      });

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].instrumentationScope.name).toBe('filone');
    });

    it('returns a tracer with a custom name', () => {
      const tracer = getTracer('custom');
      tracer.startActiveSpan('test-span', (span) => {
        span.end();
      });

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].instrumentationScope.name).toBe('custom');
    });
  });

  describe('flushTraces', () => {
    it('flushes without throwing', async () => {
      const tracer = getTracer();
      tracer.startActiveSpan('test-span', (span) => {
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      });

      await expect(flushTraces()).resolves.toBeUndefined();
    });
  });
});

describe('flushTraces without provider', () => {
  it('does not throw when no provider is registered', async () => {
    // trace.disable() was called in the previous suite's afterAll,
    // so we're working with the default no-op provider here
    await expect(flushTraces()).resolves.toBeUndefined();
  });
});
