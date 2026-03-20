import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

vi.mock('sst', () => ({
  Resource: {
    AuroraTenantSetupQueue: { url: 'https://sqs.us-east-1.amazonaws.com/123/setup-queue' },
  },
}));

const sqsMock = mockClient(SQSClient);

import { triggerTenantSetup } from './trigger-tenant-setup.js';

describe('triggerTenantSetup', () => {
  beforeEach(() => {
    sqsMock.reset();
    sqsMock.on(SendMessageCommand).resolves({});
  });

  it('sends a FIFO message with orgId as group and deduplication key', async () => {
    await triggerTenantSetup({ orgId: 'org-1', orgName: 'Acme Corp' });

    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/setup-queue',
      MessageBody: JSON.stringify({ orgId: 'org-1', orgName: 'Acme Corp' }),
      MessageGroupId: 'org-1',
      MessageDeduplicationId: 'org-1',
    });
  });
});
