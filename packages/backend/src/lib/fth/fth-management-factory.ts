import { Resource } from 'sst';
import { createFthManagementClient } from './fth-management-client.js';
import type { FthManagementClient } from './fth-management-client.js';
import { instrumentClient } from './fth-api-metrics.js';

export function createInstrumentedFthClient(): FthManagementClient {
  const client = createFthManagementClient({
    baseUrl: process.env.FTH_MANAGEMENT_API_URL!,
    token: Resource.FthManagementApiToken.value,
  });
  instrumentClient(client, { apiName: 'fth-management' });
  return client;
}
