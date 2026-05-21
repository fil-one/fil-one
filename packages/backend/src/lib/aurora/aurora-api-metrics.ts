import { instrumentApiClient, type InstrumentableClient } from '../api-client-metrics.js';

export type AuroraApiName = 'aurora-portal' | 'aurora-backoffice';

export function instrumentClient(
  client: InstrumentableClient,
  options: { apiName: AuroraApiName },
): void {
  instrumentApiClient(client, {
    apiName: options.apiName,
    durationMetricName: 'AuroraApiDuration',
    requestCountMetricName: 'AuroraApiRequestCount',
  });
}
