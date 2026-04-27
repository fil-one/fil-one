import { Resource } from 'sst';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  getDynamoClient,
  getBillingTableName,
  getUserInfoTableName,
  pollUntil,
} from '../helpers.js';

const AWS_REGION = process.env.AWS_REGION ?? 'us-east-2';
const lambda = new LambdaClient({ region: AWS_REGION });

export const AURORA_TEST_TENANT_ID = '1ab311c9-b6ad-4d4d-b707-c07d8404eaa2';

// =============================================================================
// Lambda invocation helpers
// =============================================================================

export async function invokeWorker(payload: {
  orgId: string;
  auroraTenantId: string;
  orgName?: string;
  subscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  subscriptionStatus: string;
  reportDate: string;
}): Promise<{ payload: string | undefined; functionError: string | undefined }> {
  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: (Resource as unknown as Record<string, { name: string }>).UsageReportingWorker
        .name,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );

  return {
    payload: result.Payload ? new TextDecoder().decode(result.Payload) : undefined,
    functionError: result.FunctionError,
  };
}

export async function invokeOrchestrator(): Promise<{
  payload: string | undefined;
  functionError: string | undefined;
}> {
  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: (Resource as unknown as Record<string, { name: string }>)
        .UsageReportingOrchestrator.name,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({})),
    }),
  );

  return {
    payload: result.Payload ? new TextDecoder().decode(result.Payload) : undefined,
    functionError: result.FunctionError,
  };
}

// =============================================================================
// UserInfoTable helpers
// =============================================================================

export async function seedUserProfile(orgId: string, auroraTenantId: string): Promise<void> {
  await getDynamoClient().send(
    new PutItemCommand({
      TableName: getUserInfoTableName(),
      Item: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
        auroraTenantId: { S: auroraTenantId },
        updatedAt: { S: new Date().toISOString() },
      },
    }),
  );
}

export async function deleteUserProfile(orgId: string): Promise<void> {
  try {
    await getDynamoClient().send(
      new DeleteItemCommand({
        TableName: getUserInfoTableName(),
        Key: {
          pk: { S: `ORG#${orgId}` },
          sk: { S: 'PROFILE' },
        },
      }),
    );
  } catch (error) {
    console.error('Failed to delete user profile:', error);
  }
}

// =============================================================================
// BillingTable audit record helpers
// =============================================================================

export async function getAuditRecord(
  orgId: string,
  reportDate: string,
): Promise<Record<string, AttributeValue> | null> {
  const result = await getDynamoClient().send(
    new GetItemCommand({
      TableName: getBillingTableName(),
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: `USAGE_REPORT#${reportDate}` },
      },
    }),
  );
  return result.Item ?? null;
}

export async function deleteAuditRecord(orgId: string, reportDate: string): Promise<void> {
  try {
    await getDynamoClient().send(
      new DeleteItemCommand({
        TableName: getBillingTableName(),
        Key: {
          pk: { S: `ORG#${orgId}` },
          sk: { S: `USAGE_REPORT#${reportDate}` },
        },
      }),
    );
  } catch (error) {
    console.error('Failed to delete audit record:', error);
  }
}

export async function pollForAuditRecord(
  orgId: string,
  reportDate: string,
  timeoutMs = 120_000,
): Promise<Record<string, AttributeValue>> {
  return pollUntil(() => getAuditRecord(orgId, reportDate), timeoutMs);
}

// =============================================================================
// Orchestrator-specific DDB helpers
// =============================================================================

export async function seedSubscriptionRecord(
  pk: string,
  orgId: string,
  customerId: string,
  extra?: Record<string, { S: string }>,
): Promise<void> {
  await getDynamoClient().send(
    new PutItemCommand({
      TableName: getBillingTableName(),
      Item: {
        pk: { S: pk },
        sk: { S: 'SUBSCRIPTION' },
        orgId: { S: orgId },
        stripeCustomerId: { S: customerId },
        subscriptionId: { S: `sub_test_${crypto.randomUUID().slice(0, 8)}` },
        subscriptionStatus: { S: 'active' },
        currentPeriodStart: { S: new Date().toISOString() },
        updatedAt: { S: new Date().toISOString() },
        ...extra,
      },
    }),
  );
}

export async function deleteSubscriptionRecord(pk: string): Promise<void> {
  try {
    await getDynamoClient().send(
      new DeleteItemCommand({
        TableName: getBillingTableName(),
        Key: {
          pk: { S: pk },
          sk: { S: 'SUBSCRIPTION' },
        },
      }),
    );
  } catch (error) {
    console.error('Failed to delete subscription record:', error);
  }
}

export async function invokeEnforcer(): Promise<{
  payload: string | undefined;
  functionError: string | undefined;
}> {
  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: (Resource as unknown as Record<string, { name: string }>).GracePeriodEnforcer
        .name,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({})),
    }),
  );

  return {
    payload: result.Payload ? new TextDecoder().decode(result.Payload) : undefined,
    functionError: result.FunctionError,
  };
}

export async function seedOrgProfile(orgId: string, auroraTenantId: string): Promise<void> {
  await getDynamoClient().send(
    new PutItemCommand({
      TableName: getUserInfoTableName(),
      Item: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
        auroraTenantId: { S: auroraTenantId },
        setupStatus: { S: 'AURORA_S3_ACCESS_KEY_CREATED' },
        updatedAt: { S: new Date().toISOString() },
      },
    }),
  );
}

export async function deleteOrgProfile(orgId: string): Promise<void> {
  try {
    await getDynamoClient().send(
      new DeleteItemCommand({
        TableName: getUserInfoTableName(),
        Key: {
          pk: { S: `ORG#${orgId}` },
          sk: { S: 'PROFILE' },
        },
      }),
    );
  } catch (error) {
    console.error('Failed to delete org profile:', error);
  }
}

export async function getOrgProfile(orgId: string): Promise<Record<string, { S?: string }> | null> {
  const result = await getDynamoClient().send(
    new GetItemCommand({
      TableName: getUserInfoTableName(),
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
    }),
  );
  return (result.Item as Record<string, { S?: string }>) ?? null;
}
