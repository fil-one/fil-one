import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { Resource } from 'sst';
import { sqsClient } from './sqs-client.js';

export function triggerTenantSetup({ orgId, orgName }: { orgId: string; orgName: string }) {
  return sqsClient.send(
    new SendMessageCommand({
      QueueUrl: Resource.AuroraTenantSetupQueue.url,
      MessageBody: JSON.stringify({ orgId, orgName }),
      MessageGroupId: orgId,
      MessageDeduplicationId: orgId,
    }),
  );
}
