// The management API client an orchestrator talks to: the one the config
// hands over, or one built from its base URL and token.

import { createClient, type Client } from '@filone/orchestrator-client';
import { instrumentClient } from './metrics.ts';
import type { FilOneOrchestratorConfig } from './orchestrator.ts';

export function resolveClient(config: FilOneOrchestratorConfig): Client {
  if ('client' in config.api) return config.api.client;
  const { baseUrl, accessToken: token, fetch } = config.api;
  const client = createClient({
    baseUrl,
    // Resolve the bearer credential lazily so the token isn't captured into a
    // long-lived config object; the SDK sends it as `Authorization: Bearer …`.
    auth: () => token,
    ...(fetch && { fetch }),
  });
  instrumentClient(client, { apiName: `${config.id}-management` });
  return client;
}
