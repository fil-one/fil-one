import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient, createBucket, listBuckets } from '@filone/aurora-portal-client';
import { type MetricEvent, reportMetric } from './metrics.js';
import { instrumentClient } from './aurora-api-metrics.js';

vi.mock('./metrics.js', () => ({
  reportMetric: vi.fn(),
}));

const reportMetricMock = vi.mocked(reportMetric);

function mockFetch(status: number, body: unknown = {}): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
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

describe('instrumentClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports metric with statusGroup "2xx" for a successful request', async () => {
    const client = createClient({
      baseUrl: 'https://example.com/api',
      fetch: mockFetch(200, { items: [] }),
    });
    instrumentClient(client, { apiName: 'aurora-portal' });

    await listBuckets({
      client,
      path: { tenantId: 'tenant-1' },
      throwOnError: false,
    });

    const metrics = reportedMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      apiName: 'aurora-portal',
      endpoint: 'GET /v1/tenants/{tenantId}/buckets',
      statusGroup: '2xx',
      statusCode: 200,
      AuroraApiRequestCount: 1,
    });
    expect(metrics[0].AuroraApiDuration).toBeGreaterThanOrEqual(0);
  });

  it('reports metric with statusGroup "4xx" for a client error', async () => {
    const client = createClient({
      baseUrl: 'https://example.com/api',
      fetch: mockFetch(409, { message: 'conflict' }),
    });
    instrumentClient(client, { apiName: 'aurora-portal' });

    await createBucket({
      client,
      path: { tenantId: 'tenant-1' },
      body: { name: 'my-bucket' },
      throwOnError: false,
    });

    const metrics = reportedMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      endpoint: 'POST /v1/tenants/{tenantId}/buckets',
      statusGroup: '4xx',
      statusCode: 409,
    });
  });

  it('reports metric with statusGroup "5xx" for a server error', async () => {
    const client = createClient({
      baseUrl: 'https://example.com/api',
      fetch: mockFetch(500, { message: 'internal error' }),
    });
    instrumentClient(client, { apiName: 'aurora-backoffice' });

    await listBuckets({
      client,
      path: { tenantId: 'tenant-1' },
      throwOnError: false,
    });

    const metrics = reportedMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      apiName: 'aurora-backoffice',
      statusGroup: '5xx',
      statusCode: 500,
    });
  });

  it('reports metric with statusGroup "network_error" when fetch throws', async () => {
    const client = createClient({
      baseUrl: 'https://example.com/api',
      fetch: throwingFetch(),
    });
    instrumentClient(client, { apiName: 'aurora-portal' });

    await listBuckets({
      client,
      path: { tenantId: 'tenant-1' },
      throwOnError: false,
    });

    const metrics = reportedMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      apiName: 'aurora-portal',
      statusGroup: 'network_error',
    });
    expect(metrics[0].statusCode).toBeUndefined();
  });

  it('reports exactly one metric for non-2xx HTTP responses', async () => {
    const client = createClient({
      baseUrl: 'https://example.com/api',
      fetch: mockFetch(400, { message: 'bad request' }),
    });
    instrumentClient(client, { apiName: 'aurora-portal' });

    await listBuckets({
      client,
      path: { tenantId: 'tenant-1' },
      throwOnError: false,
    });

    expect(reportedMetrics()).toHaveLength(1);
  });

  it('reports positive duration', async () => {
    const client = createClient({
      baseUrl: 'https://example.com/api',
      fetch: mockFetch(200, { items: [] }),
    });
    instrumentClient(client, { apiName: 'aurora-portal' });

    await listBuckets({
      client,
      path: { tenantId: 'tenant-1' },
      throwOnError: false,
    });

    expect(reportedMetrics()[0].AuroraApiDuration).toBeGreaterThanOrEqual(0);
  });
});
