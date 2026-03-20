import { trace } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

// Guard: skip when a real provider is already registered (e.g. test setup)
const provider = trace.getTracerProvider();
const alreadyInitialized =
  'forceFlush' in provider &&
  typeof (provider as { forceFlush?: unknown }).forceFlush === 'function';

if (!alreadyInitialized) {
  initTracing();
}

function initTracing(): void {
  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'filone',
      [ATTR_SERVICE_VERSION]: '0.0.1',
    }),
  );

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });

  tracerProvider.register();

  registerInstrumentations({
    instrumentations: [new UndiciInstrumentation()],
  });
}
