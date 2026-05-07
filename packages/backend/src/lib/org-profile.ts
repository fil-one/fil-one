import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { isOrgSetupComplete } from './org-setup-status.js';
import { ModelsTenantStatus } from '@filone/aurora-backoffice-client';

const dynamo = getDynamoClient();

export async function setOrgAuroraTenantStatus(
  orgId: string,
  status: ModelsTenantStatus,
): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
      UpdateExpression: 'SET auroraTenantStatus = :s, updatedAt = :now',
      ExpressionAttributeValues: {
        ':s': { S: status },
        ':now': { S: new Date().toISOString() },
      },
    }),
  );
}

export type OrgAuroraTenantResult =
  | { ok: true; auroraTenantId: string }
  | { ok: false; status: 503; message: string };

export async function getOrgAuroraTenant(orgId: string): Promise<OrgAuroraTenantResult> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    }),
  );
  const auroraTenantId = Item?.auroraTenantId?.S;
  const setupStatus = Item?.setupStatus?.S;
  if (!auroraTenantId || !isOrgSetupComplete(setupStatus)) {
    console.warn('Aurora tenant setup is not complete', { orgId, auroraTenantId, setupStatus });
    return {
      ok: false,
      status: 503,
      message: 'Aurora tenant setup is not complete, please try again later',
    };
  }
  return { ok: true, auroraTenantId };
}
