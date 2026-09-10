import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('sst', () => ({
  Resource: { BulkDeleteQueue: { url: 'https://sqs.example.com/bulk-delete.fifo' } },
}));

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = sendMock;
  },
  SendMessageCommand: class {
    input: Record<string, string>;

    constructor(input: Record<string, string>) {
      this.input = input;
    }
  },
}));

import { MAX_BULK_DELETE_DELIVERY_ATTEMPTS, enqueueBulkDeleteJob } from './bulk-delete-queue.js';

const payload = { orgId: 'org-1', jobId: 'job-1' };

/** The command input the client was handed. */
function sentInput(): Record<string, string> {
  return sendMock.mock.calls[0][0].input;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueBulkDeleteJob', () => {
  it('groups a job on its own id so deliveries cannot overlap', async () => {
    await enqueueBulkDeleteJob(payload, 0);

    expect(sentInput().QueueUrl).toBe('https://sqs.example.com/bulk-delete.fifo');
    expect(sentInput().MessageGroupId).toBe('job-1');
    expect(JSON.parse(sentInput().MessageBody)).toEqual(payload);
  });

  it('gives each hand-off its own deduplication id', async () => {
    // Continuation messages are byte-identical, so a shared id would leave SQS
    // dropping the hand-off within its dedup window and stranding the job.
    await enqueueBulkDeleteJob(payload, 0);
    await enqueueBulkDeleteJob(payload, 1);

    expect(sendMock.mock.calls[0][0].input.MessageDeduplicationId).toBe('job-1:0');
    expect(sendMock.mock.calls[1][0].input.MessageDeduplicationId).toBe('job-1:1');
  });

  it('states the delivery budget the worker classifies failures against', () => {
    // Must match the queue's dlq.retry in sst.config.ts.
    expect(MAX_BULK_DELETE_DELIVERY_ATTEMPTS).toBe(3);
  });
});
