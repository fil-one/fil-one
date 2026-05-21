import { instrumentApiClient, type InstrumentableClient } from '../api-client-metrics.js';

export type FthApiName = 'fth-management';

export function instrumentClient(
  client: InstrumentableClient,
  options: { apiName: FthApiName },
): void {
  instrumentApiClient(client, {
    apiName: options.apiName,
    durationMetricName: 'OrchestratorApiRequestDuration',
    requestCountMetricName: 'OrchestratorApiRequestCount',
  });
}
