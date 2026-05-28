import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockReportMetric = vi.fn();
vi.mock('./metrics.js', () => ({
  reportMetric: (...args: unknown[]) => mockReportMetric(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

import { scanAndEmitStuckTenantCount } from './stuck-tenant-metric.js';
import { FINAL_SETUP_STATUS } from './org-setup-status.js';

describe('scanAndEmitStuckTenantCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('scans UserInfoTable with the expected filter and emits the count', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [{ pk: { S: 'ORG#org-1' } }, { pk: { S: 'ORG#org-2' } }],
    });

    await scanAndEmitStuckTenantCount();

    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls).toHaveLength(1);
    expect(scanCalls[0].args[0].input).toMatchObject({
      TableName: 'UserInfoTable',
      FilterExpression: expect.stringContaining('auroraSetupFailureCount >= :three'),
      ExpressionAttributeValues: {
        ':orgPrefix': { S: 'ORG#' },
        ':profile': { S: 'PROFILE' },
        ':three': { N: '3' },
        ':complete': { S: FINAL_SETUP_STATUS },
      },
      ProjectionExpression: 'pk',
    });

    expect(mockReportMetric).toHaveBeenCalledTimes(1);
    expect(mockReportMetric.mock.calls[0][0]).toMatchObject({
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [[]],
            Metrics: [{ Name: 'StuckAuroraTenantSetupCount', Unit: 'Count' }],
          },
        ],
      },
      StuckAuroraTenantSetupCount: 2,
    });
  });

  it('emits 0 when no orgs match the filter', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await scanAndEmitStuckTenantCount();

    expect(mockReportMetric.mock.calls[0][0].StuckAuroraTenantSetupCount).toBe(0);
  });

  it('paginates through multiple Scan pages and sums the counts', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [{ pk: { S: 'ORG#org-1' } }],
        LastEvaluatedKey: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
      })
      .resolvesOnce({
        Items: [{ pk: { S: 'ORG#org-2' } }, { pk: { S: 'ORG#org-3' } }],
      });

    await scanAndEmitStuckTenantCount();

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(mockReportMetric.mock.calls[0][0].StuckAuroraTenantSetupCount).toBe(3);
  });

  it('logs but does not throw when the Scan fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(ScanCommand).rejects(new Error('DynamoDB throttle'));

    await expect(scanAndEmitStuckTenantCount()).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(mockReportMetric).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
