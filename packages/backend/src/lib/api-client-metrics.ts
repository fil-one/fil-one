import { reportMetric } from './metrics.js';

interface InterceptorOptions {
  url?: string;
}

export interface InstrumentableClient {
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

export interface InstrumentApiClientOptions<ApiName extends string> {
  apiName: ApiName;
  durationMetricName: string;
  requestCountMetricName: string;
}

export function instrumentApiClient<ApiName extends string>(
  client: InstrumentableClient,
  options: InstrumentApiClientOptions<ApiName>,
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

    reportApiMetric({
      apiName: options.apiName,
      durationMetricName: options.durationMetricName,
      requestCountMetricName: options.requestCountMetricName,
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

      reportApiMetric({
        apiName: options.apiName,
        durationMetricName: options.durationMetricName,
        requestCountMetricName: options.requestCountMetricName,
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

function reportApiMetric(data: {
  apiName: string;
  durationMetricName: string;
  requestCountMetricName: string;
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
            { Name: data.durationMetricName, Unit: 'Milliseconds' },
            { Name: data.requestCountMetricName, Unit: 'Count' },
          ],
        },
      ],
    },
    apiName: data.apiName,
    endpoint: data.endpoint,
    statusGroup: data.statusGroup,
    statusCode: data.statusCode,
    [data.durationMetricName]: data.duration,
    [data.requestCountMetricName]: 1,
  });
}
