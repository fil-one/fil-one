import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
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
