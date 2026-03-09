import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockProcessTenantSetup = vi.fn();
vi.mock('../lib/aurora-tenant-setup.js', () => ({
  processTenantSetup: (...args: unknown[]) => mockProcessTenantSetup(...args),
}));

import { handler } from './aurora-tenant-setup.js';
import { buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSQSEvent(body: object): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        receiptHandle: 'handle-1',
        body: JSON.stringify(body),
        attributes: {} as SQSEvent['Records'][0]['attributes'],
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:123:queue',
        awsRegion: 'us-east-1',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aurora-tenant-setup-consumer handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to processTenantSetup with parsed message body', async () => {
    mockProcessTenantSetup.mockResolvedValue(undefined);
    const message = { orgId: 'org-1', orgName: 'Test Org' };

    await handler(buildSQSEvent(message), buildContext());

    expect(mockProcessTenantSetup).toHaveBeenCalledWith(message);
  });

  it('throws when batch contains more than one record', async () => {
    const event = buildSQSEvent({ orgId: 'org-1', orgName: 'Test Org' });
    event.Records.push({ ...event.Records[0], messageId: 'msg-2' });

    await expect(handler(event, buildContext())).rejects.toThrow(
      'Expected exactly 1 SQS record, got 2',
    );
  });

  it('propagates errors from processTenantSetup', async () => {
    mockProcessTenantSetup.mockRejectedValue(new Error('setup failed'));

    await expect(
      handler(buildSQSEvent({ orgId: 'org-1', orgName: 'Test Org' }), buildContext()),
    ).rejects.toThrow('setup failed');
  });
});
