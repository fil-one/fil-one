import { ScanCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { reportMetric } from './metrics.js';
import { OrgSetupStatus } from './org-setup-status.js';

const dynamo = getDynamoClient();

// Scans UserInfoTable for org-profile rows whose setup has failed at least
// three times without ever completing, and emits the count as the
// StuckAuroraTenantSetupCount EMF gauge. Called on counter transitions only
// (2 → 3 on a failing attempt; ≥3 → 0 on a recovering success), so the scan
// cost matches how often orgs actually get stuck or unstuck.
//
// At current scale (< few thousand orgs) a Scan with FilterExpression is
// fine. Errors are logged and swallowed so a transient DynamoDB issue
// doesn't mask the underlying tenant-setup error to the user.
export async function scanAndEmitStuckTenantCount(): Promise<void> {
  try {
    let stuckCount = 0;
    let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
    do {
      const out = await dynamo.send(
        new ScanCommand({
          TableName: Resource.UserInfoTable.name,
          FilterExpression:
            'begins_with(pk, :orgPrefix) AND sk = :profile AND setupFailureCount >= :three AND setupStatus <> :complete',
          ExpressionAttributeValues: {
            ':orgPrefix': { S: 'ORG#' },
            ':profile': { S: 'PROFILE' },
            ':three': { N: '3' },
            ':complete': { S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED },
          },
          ExclusiveStartKey: lastEvaluatedKey,
          ProjectionExpression: 'pk',
        }),
      );
      stuckCount += out.Items?.length ?? 0;
      lastEvaluatedKey = out.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    reportMetric({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [[]],
            Metrics: [{ Name: 'StuckAuroraTenantSetupCount', Unit: 'Count' }],
          },
        ],
      },
      StuckAuroraTenantSetupCount: stuckCount,
    });
  } catch (err) {
    console.error('[stuck-tenant-metric] failed to scan or emit', { error: err });
  }
}
