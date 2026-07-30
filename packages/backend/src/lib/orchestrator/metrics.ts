import { instrumentApiClient, type InstrumentableClient } from '../api-client-metrics.js';

// Unlike fth-api-metrics.ts, the apiName is an open string: this module backs
// a reusable orchestrator factory, so the name is derived from the configured
// orchestrator id (`${id}-management`) rather than a closed union. The metric
// names match the other orchestrators so dashboards pick new instances up via
// the apiName dimension.
export function instrumentClient(client: InstrumentableClient, options: { apiName: string }): void {
  instrumentApiClient(client, {
    apiName: options.apiName,
    durationMetricName: 'OrchestratorApiRequestDuration',
    requestCountMetricName: 'OrchestratorApiRequestCount',
  });
}
