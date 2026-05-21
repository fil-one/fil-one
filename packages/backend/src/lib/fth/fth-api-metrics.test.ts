import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type MetricEvent, reportMetric } from '../metrics.js';
import { instrumentClient } from './fth-api-metrics.js';
import { createFthManagementClient } from './fth-management-client.js';

vi.mock('../metrics.js', () => ({
  reportMetric: vi.fn(),
}));

const reportMetricMock = vi.mocked(reportMetric);

function mockFetch(status: number, body: unknown = {}): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function throwingFetch(): typeof fetch {
  return vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
}

function reportedMetrics(): MetricEvent[] {
  return reportMetricMock.mock.calls.map(([event]) => event);
}

function buildInstrumentedClient(fetchImpl: typeof fetch) {
  const client = createFthManagementClient({
    baseUrl: 'https://api.fortilyx.com',
    token: 'kid.secret',
    fetch: fetchImpl,
  });
  instrumentClient(client, { apiName: 'fth-management' });
  return client;
}

describe('instrumentClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports metric with statusGroup "2xx" for a successful request', async () => {
    const client = buildInstrumentedClient(mockFetch(200, { id: '1', externalId: 'org-1' }));

    await client.getClient('org-1');

    const metrics = reportedMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      apiName: 'fth-management',
      endpoint: 'GET /management/v1/clients/{clientRef}',
      statusGroup: '2xx',
      statusCode: 200,
      FthApiRequestCount: 1,
    });
    expect(metrics[0].FthApiDuration).toBeGreaterThanOrEqual(0);
  });

  it('reports metric with statusGroup "4xx" for a client error', async () => {
    const client = buildInstrumentedClient(mockFetch(409, { message: 'conflict' }));

    await expect(
      client.createClient({ externalId: 'org-1', displayName: 'Org One', idempotencyKey: 'k' }),
    ).rejects.toThrow();

    const metrics = reportedMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      endpoint: 'POST /management/v1/clients',
      statusGroup: '4xx',
      statusCode: 409,
    });
  });

  it('reports metric with statusGroup "5xx" for a server error', async () => {
    const client = buildInstrumentedClient(mockFetch(500, { message: 'internal error' }));

    await expect(client.getClient('org-1')).rejects.toThrow();

    const metrics = reportedMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      apiName: 'fth-management',
      statusGroup: '5xx',
      statusCode: 500,
    });
  });

  it('reports metric with statusGroup "network_error" when fetch throws', async () => {
    const client = buildInstrumentedClient(throwingFetch());

    await expect(client.getClient('org-1')).rejects.toBeInstanceOf(TypeError);

    const metrics = reportedMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      apiName: 'fth-management',
      endpoint: 'GET /management/v1/clients/{clientRef}',
      statusGroup: 'network_error',
    });
    expect(metrics[0].statusCode).toBeUndefined();
  });

  it('reports exactly one metric for non-2xx HTTP responses', async () => {
    const client = buildInstrumentedClient(mockFetch(400, { message: 'bad request' }));

    await expect(client.getClient('org-1')).rejects.toThrow();

    expect(reportedMetrics()).toHaveLength(1);
  });

  it('reports positive duration', async () => {
    const client = buildInstrumentedClient(mockFetch(200, { id: '1' }));

    await client.getClient('org-1');

    expect(reportedMetrics()[0].FthApiDuration).toBeGreaterThanOrEqual(0);
  });

  it('emits the CloudWatch EMF envelope with FthApi metric definitions', async () => {
    const client = buildInstrumentedClient(mockFetch(200, { id: '1' }));

    await client.getClient('org-1');

    expect(reportedMetrics()[0]._aws).toMatchObject({
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['apiName', 'endpoint', 'statusGroup']],
          Metrics: [
            { Name: 'FthApiDuration', Unit: 'Milliseconds' },
            { Name: 'FthApiRequestCount', Unit: 'Count' },
          ],
        },
      ],
    });
  });
});
