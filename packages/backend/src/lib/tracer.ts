import { trace } from '@opentelemetry/api';

export function getTracer(name?: string) {
  return trace.getTracer(name ?? 'filone');
}

export async function flushTraces(): Promise<void> {
  try {
    const provider = trace.getTracerProvider();
    if ('forceFlush' in provider && typeof provider.forceFlush === 'function') {
      await provider.forceFlush();
    }
  } catch (err) {
    console.error('[tracer] flushTraces failed:', err);
  }
}
