import assert from 'node:assert';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { Resource } from 'sst';
import {
  createAuroraTenant,
  createAuroraTenantApiKey,
  setupAuroraTenant,
} from './aurora-backoffice.js';
import { OrgSetupStatus } from './org-setup-status.js';

export { OrgSetupStatus };

export interface AuroraTenantSetupMessage {
  orgId: string;
  orgName: string;
}

const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});

export async function processTenantSetup(message: AuroraTenantSetupMessage): Promise<void> {
  const { orgId, orgName } = message;
  const key = { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } };

  const { Item } = await dynamo.send(
    new GetItemCommand({ TableName: Resource.UserInfoTable.name, Key: key }),
  );

  if (!Item) {
    throw new Error(`Org profile not found for org ${orgId}`);
  }

  const setupStatus = Item.setupStatus?.S;

  switch (setupStatus) {
    case OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED:
      return;

    case OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE: {
      const auroraTenantId = Item.auroraTenantId?.S;
      assert(auroraTenantId, `auroraTenantId missing in org profile for org ${orgId}`);
      await createAndStoreApiKey(orgId, auroraTenantId, key);
      return;
    }

    case OrgSetupStatus.FILONE_ORG_CREATED:
    case undefined: {
      const auroraTenantId = await createTenant(orgId, orgName, key);
      await runSetup(orgId, auroraTenantId, key);
      await createAndStoreApiKey(orgId, auroraTenantId, key);
      return;
    }

    case OrgSetupStatus.AURORA_TENANT_CREATED: {
      const auroraTenantId = Item.auroraTenantId?.S;
      assert(auroraTenantId, `auroraTenantId missing in org profile for org ${orgId}`);
      await runSetup(orgId, auroraTenantId, key);
      await createAndStoreApiKey(orgId, auroraTenantId, key);
      return;
    }

    default:
      throw new Error(`Unexpected setupStatus "${setupStatus}" for org ${orgId}`);
  }
}

async function createTenant(
  orgId: string,
  displayName: string,
  key: Record<string, { S: string }>,
): Promise<string> {
  const { auroraTenantId } = await createAuroraTenant({ orgId, displayName });

  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      UpdateExpression: 'SET auroraTenantId = :tid, setupStatus = :status, updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(setupStatus) OR setupStatus = :expected',
      ExpressionAttributeValues: {
        ':tid': { S: auroraTenantId },
        ':status': { S: OrgSetupStatus.AURORA_TENANT_CREATED },
        ':expected': { S: OrgSetupStatus.FILONE_ORG_CREATED },
        ':now': { S: new Date().toISOString() },
      },
    }),
  );

  return auroraTenantId;
}

async function runSetup(
  orgId: string,
  auroraTenantId: string,
  key: Record<string, { S: string }>,
): Promise<void> {
  const { lastSetupStep } = await setupAuroraTenant({ tenantId: auroraTenantId });

  if (lastSetupStep !== 'FINISHED') {
    throw new Error(
      `Aurora tenant setup not finished for org ${orgId}: lastSetupStep=${lastSetupStep}`,
    );
  }

  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      UpdateExpression: 'SET setupStatus = :status, updatedAt = :now',
      ConditionExpression: 'setupStatus = :expected',
      ExpressionAttributeValues: {
        ':status': { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
        ':expected': { S: OrgSetupStatus.AURORA_TENANT_CREATED },
        ':now': { S: new Date().toISOString() },
      },
    }),
  );
}

async function createAndStoreApiKey(
  orgId: string,
  auroraTenantId: string,
  key: Record<string, { S: string }>,
): Promise<void> {
  const stage = process.env.FILONE_STAGE!;
  const { token } = await createAuroraTenantApiKey({ tenantId: auroraTenantId, orgId });

  await ssm.send(
    new PutParameterCommand({
      Name: `/filone/${stage}/aurora-portal/tenant-api-key/${auroraTenantId}`,
      Value: token,
      Type: 'SecureString',
      Overwrite: true,
    }),
  );

  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      UpdateExpression: 'SET setupStatus = :status, updatedAt = :now',
      ConditionExpression: 'setupStatus = :expected',
      ExpressionAttributeValues: {
        ':status': { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        ':expected': { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
        ':now': { S: new Date().toISOString() },
      },
    }),
  );
}
