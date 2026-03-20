import type { MiddlewareObj, Request } from '@middy/core';
import type { Context } from 'aws-lambda';
import { trace, SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import middy from '@middy/core';
import { getTracer, flushTraces } from '../lib/tracer.js';

// ---------------------------------------------------------------------------
// Root span access (WeakMap-based)
// ---------------------------------------------------------------------------

const rootSpanMap = new WeakMap<object, Span>();

export function setRootSpan(event: object, span: Span): void {
  rootSpanMap.set(event, span);
}

const noopSpan = trace.getTracer('noop').startSpan('noop');
noopSpan.end();

export function getRootSpan(event: object): Span {
  return rootSpanMap.get(event) ?? noopSpan;
}

// ---------------------------------------------------------------------------
// Event type detection
// ---------------------------------------------------------------------------

interface DetectedEvent {
  trigger: 'http' | 'pubsub' | 'timer' | 'other';
  spanName: string;
  attributes: Record<string, string>;
}

function detectEventType(event: Record<string, unknown>, context: Context): DetectedEvent {
  // HTTP — API Gateway v2
  const rc = event.requestContext as Record<string, unknown> | undefined;
  const http = rc?.http as Record<string, string> | undefined;
  if (http) {
    const method = http.method ?? 'UNKNOWN';
    const path = (event.rawPath as string) ?? '/';
    return {
      trigger: 'http',
      spanName: `${method} ${path}`,
      attributes: {
        'http.request.method': method,
        'url.path': path,
        'http.route': path,
      },
    };
  }

  // SQS
  const records = event.Records as Array<Record<string, unknown>> | undefined;
  if (records?.[0]?.eventSource === 'aws:sqs') {
    return {
      trigger: 'pubsub',
      spanName: context.functionName,
      attributes: { 'messaging.system': 'aws_sqs' },
    };
  }

  // CloudWatch Events / EventBridge
  if (event.source === 'aws.events') {
    return {
      trigger: 'timer',
      spanName: context.functionName,
      attributes: {},
    };
  }

  // Fallback
  return {
    trigger: 'other',
    spanName: context.functionName,
    attributes: {},
  };
}

// ---------------------------------------------------------------------------
// Span kind by trigger type
// ---------------------------------------------------------------------------

const SPAN_KIND_MAP: Record<string, SpanKind> = {
  http: SpanKind.SERVER,
  pubsub: SpanKind.CONSUMER,
  timer: SpanKind.INTERNAL,
  other: SpanKind.INTERNAL,
};

// ---------------------------------------------------------------------------
// tracingMiddleware — manages span end/status/flush (NOT creation)
//
// Span creation + OTel context propagation is handled by tracedHandler's
// outer wrapper via startActiveSpan(). The middleware reads the span from
// the WeakMap and manages its lifecycle in after/onError hooks.
// ---------------------------------------------------------------------------

function tracingMiddleware(): MiddlewareObj {
  const after = async (request: Request): Promise<void> => {
    const span = getRootSpan(request.event as object);

    const response = request.response as Record<string, unknown> | undefined;
    const statusCode = response?.statusCode;
    if (typeof statusCode === 'number') {
      span.setAttribute('http.response.status_code', statusCode);
    }

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    await flushTraces();
  };

  const onError = async (request: Request): Promise<void> => {
    const span = getRootSpan(request.event as object);

    if (request.error) {
      span.recordException(request.error);
    }

    const response = request.response as Record<string, unknown> | undefined;
    const statusCode = response?.statusCode;
    if (typeof statusCode === 'number') {
      span.setAttribute('http.response.status_code', statusCode);
    }

    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: request.error?.message,
    });
    span.end();
    await flushTraces();
  };

  return { after, onError };
}

// ---------------------------------------------------------------------------
// tracedHandler — creates the root span, propagates OTel context via
// startActiveSpan(), and delegates to a Middy chain for middleware ordering.
//
// Usage:
//   export const handler = tracedHandler(baseHandler)
//     .use(httpHeaderNormalizer())
//     .use(authMiddleware())
//     .use(errorHandlerMiddleware());
// ---------------------------------------------------------------------------

// Middy middleware types are contravariant in TEvent — a middleware typed for
// APIGatewayProxyEventV2 cannot be assigned to MiddlewareObj<unknown>.
// Middy's own UseFn resolves this with `any`. We match that here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMiddleware = MiddlewareObj<any, any, Error, any, any>;

export interface TracedHandler<TEvent, TResult> {
  (event: TEvent, context: Context): Promise<TResult>;
  use(middleware: AnyMiddleware): TracedHandler<TEvent, TResult>;
}

export function tracedHandler<TEvent, TResult>(
  baseHandler: (event: TEvent, context: Context) => Promise<TResult>,
): TracedHandler<TEvent, TResult> {
  const chain = middy(baseHandler).use(tracingMiddleware());

  const handler = async function (event: TEvent, ctx: Context): Promise<TResult> {
    const detected = detectEventType(event as Record<string, unknown>, ctx);
    const tracer = getTracer();

    return tracer.startActiveSpan(
      detected.spanName,
      {
        kind: SPAN_KIND_MAP[detected.trigger],
        attributes: {
          'faas.trigger': detected.trigger,
          'faas.invocation_id': ctx.awsRequestId,
          ...detected.attributes,
        },
      },
      async (span) => {
        setRootSpan(event as object, span);
        // The span lifecycle (end + flush) is managed by tracingMiddleware's
        // after/onError hooks inside the Middy chain.
        return chain(event, ctx) as Promise<TResult>;
      },
    );
  } as TracedHandler<TEvent, TResult>;

  handler.use = (middleware: AnyMiddleware) => {
    chain.use(middleware);
    return handler;
  };

  return handler;
}
