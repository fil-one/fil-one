import { reportMetric } from './metrics.js';

export type AuroraApiName = 'aurora-portal' | 'aurora-backoffice';

export interface InstrumentClientOptions {
  apiName: AuroraApiName;
}

interface InterceptorOptions {
  url?: string;
}

interface InstrumentableClient {
  interceptors: {
    request: {
      use(
        fn: (request: Request, options: InterceptorOptions) => Request | Promise<Request>,
      ): number;
    };
    response: {
      use(
        fn: (
          response: Response,
          request: Request,
          options: InterceptorOptions,
        ) => Response | Promise<Response>,
      ): number;
    };
    error: {
      use(
        fn: (
          error: unknown,
          response: Response | undefined,
          request: Request,
          options: InterceptorOptions,
        ) => unknown,
      ): number;
    };
  };
}

export function instrumentClient(
  client: InstrumentableClient,
  options: InstrumentClientOptions,
): void {
  const timings = new WeakMap<Request, number>();

  client.interceptors.request.use((request, _options) => {
    timings.set(request, performance.now());
    return request;
  });

  client.interceptors.response.use((response, request, requestOptions) => {
    const start = timings.get(request);
    const duration = start !== undefined ? performance.now() - start : 0;
    const endpoint = `${request.method} ${requestOptions.url ?? 'unknown'}`;

    reportAuroraApiMetric({
      apiName: options.apiName,
      endpoint,
      statusGroup: statusGroup(response.status),
      statusCode: response.status,
      duration,
    });

    return response;
  });

  client.interceptors.error.use((error, response, request, requestOptions) => {
    // Only emit for network errors (response is undefined).
    // For HTTP errors, the response interceptor already emitted the metric.
    if (response === undefined) {
      const start = timings.get(request);
      const duration = start !== undefined ? performance.now() - start : 0;
      const endpoint = `${request.method} ${requestOptions.url ?? 'unknown'}`;

      reportAuroraApiMetric({
        apiName: options.apiName,
        endpoint,
        statusGroup: 'network_error',
        statusCode: undefined,
        duration,
      });
    }

    return error;
  });
}

function statusGroup(status: number): string {
  const group = Math.floor(status / 100);
  return `${group}xx`;
}

function reportAuroraApiMetric(data: {
  apiName: AuroraApiName;
  endpoint: string;
  statusGroup: string;
  statusCode: number | undefined;
  duration: number;
}): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['apiName', 'endpoint', 'statusGroup']],
          Metrics: [
            { Name: 'AuroraApiDuration', Unit: 'Milliseconds' },
            { Name: 'AuroraApiRequestCount', Unit: 'Count' },
          ],
        },
      ],
    },
    apiName: data.apiName,
    endpoint: data.endpoint,
    statusGroup: data.statusGroup,
    statusCode: data.statusCode,
    AuroraApiDuration: data.duration,
    AuroraApiRequestCount: 1,
  });
}
