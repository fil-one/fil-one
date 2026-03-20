import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { trace, SpanKind, SpanStatusCode, context as otelContext } from '@opentelemetry/api';
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-node';
import type { Context } from 'aws-lambda';
import { tracedHandler, getRootSpan, setRootSpan } from './tracing.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// OTel test provider
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHttpEvent(method = 'GET', path = '/api/test') {
  return buildEvent({ method, rawPath: path });
}

function buildSqsEvent() {
  return {
    Records: [{ eventSource: 'aws:sqs', body: '{}' }],
  };
}

function buildTimerEvent() {
  return {
    source: 'aws.events',
    'detail-type': 'Scheduled Event',
  };
}

function buildGenericEvent() {
  return { orgId: 'org-1', reportDate: '2026-03-20' };
}

function ctx(overrides?: Partial<Context>): Context {
  return buildContext({ functionName: 'my-function', ...overrides });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tracedHandler', () => {
  describe('HTTP event auto-detection', () => {
    it('creates a span with HTTP attributes', async () => {
      const handler = tracedHandler(async () => ({ statusCode: 200, body: 'ok' }));

      await handler(buildHttpEvent('POST', '/api/users'), ctx());

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        name: 'POST /api/users',
        kind: SpanKind.SERVER,
        status: { code: SpanStatusCode.OK },
      });
      expect(spans[0].attributes).toMatchObject({
        'faas.trigger': 'http',
        'faas.invocation_id': 'test-request-id',
        'http.request.method': 'POST',
        'url.path': '/api/users',
        'http.route': '/api/users',
        'http.response.status_code': 200,
      });
    });
  });

  describe('SQS event auto-detection', () => {
    it('creates a span with SQS attributes', async () => {
      const handler = tracedHandler(async () => {});

      await handler(buildSqsEvent(), ctx());

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        name: 'my-function',
        kind: SpanKind.CONSUMER,
        status: { code: SpanStatusCode.OK },
      });
      expect(spans[0].attributes).toMatchObject({
        'faas.trigger': 'pubsub',
        'messaging.system': 'aws_sqs',
      });
    });
  });

  describe('timer event auto-detection', () => {
    it('creates a span with timer trigger', async () => {
      const handler = tracedHandler(async () => {});

      await handler(buildTimerEvent(), ctx());

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        name: 'my-function',
        kind: SpanKind.INTERNAL,
      });
      expect(spans[0].attributes['faas.trigger']).toBe('timer');
    });
  });

  describe('fallback event detection', () => {
    it('creates a span with function name', async () => {
      const handler = tracedHandler(async () => {});

      await handler(buildGenericEvent(), ctx());

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        name: 'my-function',
        kind: SpanKind.INTERNAL,
      });
      expect(spans[0].attributes['faas.trigger']).toBe('other');
    });
  });

  describe('error handling', () => {
    it('records exception and sets ERROR status', async () => {
      const handler = tracedHandler(async () => {
        throw new Error('handler failed');
      });

      await expect(handler(buildHttpEvent(), ctx())).rejects.toThrow('handler failed');

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].status).toEqual({
        code: SpanStatusCode.ERROR,
        message: 'handler failed',
      });
      expect(spans[0].events).toHaveLength(1);
      expect(spans[0].events[0].name).toBe('exception');
    });
  });

  // -----------------------------------------------------------------------
  // Error handling interaction with errorHandlerMiddleware
  //
  // Middy v7 runs ALL onError hooks in reverse registration order, even
  // after one sets a response. The after hooks never run on the error path.
  //
  // For HTTP handlers with errorHandlerMiddleware:
  //   1. errorHandler.onError — records exception on span, sets 500 response
  //   2. tracing.onError — sees response already set (error was handled),
  //      skips recordException to avoid duplicates, sets ERROR status,
  //      captures status code, ends span, flushes
  //
  // For non-HTTP handlers (SQS, jobs) without errorHandlerMiddleware:
  //   1. tracing.onError — no response set, records exception, sets ERROR
  //      status, ends span, flushes. Error propagates to Lambda for retry.
  // -----------------------------------------------------------------------

  describe('error handler middleware integration', () => {
    it('sets ERROR status and captures status code from errorHandler response', async () => {
      const handler = tracedHandler(async () => {
        throw new Error('unhandled error');
      }).use({
        // Simulates errorHandlerMiddleware: records exception, sets response.
        onError: async (request) => {
          getRootSpan(request.event as object).recordException(request.error as Error);
          request.response = { statusCode: 500, body: 'Internal Server Error' };
        },
      });

      await handler(buildHttpEvent(), ctx());

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].status).toEqual({
        code: SpanStatusCode.ERROR,
        message: 'unhandled error',
      });
      expect(spans[0].attributes['http.response.status_code']).toBe(500);
      // Exception recorded once (by errorHandler), not twice
      expect(spans[0].events.filter((e) => e.name === 'exception')).toHaveLength(1);
    });
  });

  describe('response status code', () => {
    it('records HTTP response status code on success', async () => {
      const handler = tracedHandler(async () => ({ statusCode: 201, body: '{}' }));

      await handler(buildHttpEvent(), ctx());

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes['http.response.status_code']).toBe(201);
    });
  });

  describe('OTel context propagation', () => {
    it('sets the root span as active during handler execution', async () => {
      let activeSpanDuringHandler: unknown = null;

      const handler = tracedHandler(async (event: unknown) => {
        activeSpanDuringHandler = trace.getActiveSpan();
        return { statusCode: 200, body: 'ok' };
      });

      await handler(buildHttpEvent(), ctx());

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      // startActiveSpan creates a wrapper span; the active span during
      // handler execution should be the one we created
      expect(activeSpanDuringHandler).toBeDefined();
    });
  });

  describe('.use() chaining', () => {
    it('allows adding middleware via .use()', async () => {
      const order: string[] = [];

      const handler = tracedHandler(async () => {
        order.push('handler');
        return { statusCode: 200, body: 'ok' };
      }).use({
        before: async () => {
          order.push('middleware-before');
        },
        after: async () => {
          order.push('middleware-after');
        },
      });

      await handler(buildHttpEvent(), ctx());

      expect(order).toEqual(['middleware-before', 'handler', 'middleware-after']);
    });
  });
});

describe('getRootSpan / setRootSpan', () => {
  it('returns a NonRecordingSpan when no span is set', () => {
    const event = {};
    const span = getRootSpan(event);

    // Should not throw — NonRecordingSpan accepts any method call
    span.setAttribute('test', 'value');
    span.end();
  });

  it('returns the span that was set', () => {
    const event = {};
    const mockSpan = trace.getTracer('test').startSpan('test');

    setRootSpan(event, mockSpan);
    const retrieved = getRootSpan(event);

    expect(retrieved).toBe(mockSpan);
    mockSpan.end();
  });
});
