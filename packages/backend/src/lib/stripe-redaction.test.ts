import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: { UserInfoTable: { name: 'UserInfoTable' } },
}));

const mockRawRequest = vi.fn();
vi.mock('./stripe-client.js', () => ({
  getStripeClient: () => ({ rawRequest: (...args: unknown[]) => mockRawRequest(...args) }),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.FILONE_STAGE = 'test';

import { redactStripeCustomers } from './stripe-redaction.js';
import { OrgDeletionStatus, type OrgDeletionRecord } from './dynamo-records.js';

const ORG_ID = 'org-1';
const CUSTOMERS = ['cus_1'];

function deletionRecord(overrides?: Partial<OrgDeletionRecord>): OrgDeletionRecord {
  return {
    pk: `ORG#${ORG_ID}`,
    sk: 'DELETION',
    status: OrgDeletionStatus.Pending,
    requestedAt: '2026-07-10T00:00:00.000Z',
    requestedByUserId: 'user-1',
    members: [{ userId: 'user-1', sub: 'auth0|sub-1' }],
    attemptCount: 0,
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

function deletionItem(overrides?: Record<string, unknown>) {
  return marshall({
    pk: `ORG#${ORG_ID}`,
    sk: 'DELETION',
    status: OrgDeletionStatus.Pending,
    requestedAt: '2026-07-10T00:00:00.000Z',
    requestedByUserId: 'user-1',
    members: [{ userId: 'user-1', sub: 'auth0|sub-1' }],
    ...overrides,
  });
}

/** Happy-path Redaction Jobs API: create → validate → GET reports `ready` → run. */
function stubRedactionJob(statusOnGet = 'ready') {
  mockRawRequest.mockImplementation((method: string, path: string) => {
    if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
      return Promise.resolve({ id: 'prj_1', status: 'created' });
    }
    if (method === 'GET') return Promise.resolve({ id: 'prj_1', status: statusOnGet });
    return Promise.resolve({ id: 'prj_1' });
  });
}

function rawRequestCalls() {
  return mockRawRequest.mock.calls.map(([method, path]) => `${method} ${path}`);
}

function jobIdWrites() {
  return ddbMock
    .commandCalls(UpdateItemCommand)
    .filter((c) => c.args[0].input.UpdateExpression?.includes('stripeRedactionJobId'));
}

describe('redactStripeCustomers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock.on(GetItemCommand).resolves({ Item: deletionItem() });
    stubRedactionJob();
  });

  it('is a no-op when the snapshot has no customers', async () => {
    await redactStripeCustomers(ORG_ID, deletionRecord(), []);

    expect(mockRawRequest).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('creates the job for every customer, persists its id, validates and runs it', async () => {
    await redactStripeCustomers(ORG_ID, deletionRecord(), ['cus_1', 'cus_2']);

    expect(mockRawRequest).toHaveBeenCalledWith('POST', '/v1/privacy/redaction_jobs', {
      objects: { customers: ['cus_1', 'cus_2'] },
    });
    expect(rawRequestCalls()).toEqual([
      'POST /v1/privacy/redaction_jobs',
      'POST /v1/privacy/redaction_jobs/prj_1/validate',
      'GET /v1/privacy/redaction_jobs/prj_1',
      'POST /v1/privacy/redaction_jobs/prj_1/run',
    ]);
    expect(jobIdWrites()).toHaveLength(1);
    expect(jobIdWrites()[0].args[0].input.ExpressionAttributeValues?.[':jobId']?.S).toBe('prj_1');
  });

  it('writes the job id with an attribute_not_exists condition', async () => {
    await redactStripeCustomers(ORG_ID, deletionRecord(), CUSTOMERS);

    expect(jobIdWrites()[0].args[0].input.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(stripeRedactionJobId)',
    );
  });

  it('throws on a not-yet-ready job, then advances the SAME job on re-entry without re-creating', async () => {
    stubRedactionJob('validating');

    await expect(redactStripeCustomers(ORG_ID, deletionRecord(), CUSTOMERS)).rejects.toThrow(
      /not ready yet/,
    );

    // Re-entry with the persisted id: the job is fetched and run, never re-created.
    mockRawRequest.mockClear();
    stubRedactionJob('ready');

    await redactStripeCustomers(
      ORG_ID,
      deletionRecord({ stripeRedactionJobId: 'prj_1' }),
      CUSTOMERS,
    );

    expect(rawRequestCalls()).toEqual([
      'GET /v1/privacy/redaction_jobs/prj_1',
      'POST /v1/privacy/redaction_jobs/prj_1/run',
    ]);
  });

  it('treats an already redacting/succeeded job as done on re-entry', async () => {
    stubRedactionJob('redacting');

    await redactStripeCustomers(
      ORG_ID,
      deletionRecord({ stripeRedactionJobId: 'prj_1' }),
      CUSTOMERS,
    );

    expect(rawRequestCalls()).toEqual(['GET /v1/privacy/redaction_jobs/prj_1']);
  });

  it('tolerates a missing customer at job creation', async () => {
    mockRawRequest.mockRejectedValue(
      Object.assign(new Error('No such customer'), { code: 'resource_missing' }),
    );

    await redactStripeCustomers(ORG_ID, deletionRecord(), CUSTOMERS);

    expect(rawRequestCalls()).toEqual(['POST /v1/privacy/redaction_jobs']);
    expect(jobIdWrites()).toHaveLength(0);
  });

  it('does not treat a message-only "already redacted" error as success (must be resource_missing)', async () => {
    mockRawRequest.mockRejectedValue(new Error('This customer was already redacted elsewhere'));

    await expect(redactStripeCustomers(ORG_ID, deletionRecord(), CUSTOMERS)).rejects.toThrow(
      /already redacted elsewhere/,
    );
  });

  it('persists the job id conditionally and defers to a concurrently stored id', async () => {
    // Another worker stored prj_stored between our create and our write.
    ddbMock
      .on(UpdateItemCommand, {
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(stripeRedactionJobId)',
      })
      .rejects(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
    ddbMock
      .on(GetItemCommand)
      .resolves({ Item: deletionItem({ stripeRedactionJobId: 'prj_stored' }) });
    mockRawRequest.mockImplementation((method: string, path: string) => {
      if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
        return Promise.resolve({ id: 'prj_mine', status: 'created' });
      }
      if (method === 'GET') return Promise.resolve({ id: 'prj_stored', status: 'ready' });
      return Promise.resolve({ id: 'prj_stored' });
    });

    await redactStripeCustomers(ORG_ID, deletionRecord(), CUSTOMERS);

    // The losing worker's own job (prj_mine) is never validated or driven —
    // the stored job's lifecycle is advanced instead.
    expect(rawRequestCalls()).toEqual([
      'POST /v1/privacy/redaction_jobs',
      'GET /v1/privacy/redaction_jobs/prj_stored',
      'POST /v1/privacy/redaction_jobs/prj_stored/run',
    ]);
  });

  it('throws when the conditional write fails but no stored id can be re-read', async () => {
    ddbMock
      .on(UpdateItemCommand, {
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(stripeRedactionJobId)',
      })
      .rejects(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    await expect(redactStripeCustomers(ORG_ID, deletionRecord(), CUSTOMERS)).rejects.toThrow(
      /no stored id was found on re-read/,
    );
  });

  it('recovers the existing job on an already-in-a-redaction-job conflict instead of skipping', async () => {
    // A previous pass created a job but crashed before persisting its id.
    mockRawRequest.mockImplementation((method: string, path: string) => {
      if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
        return Promise.reject(
          Object.assign(new Error('Customer cus_1 is already included in a redaction job.'), {
            type: 'invalid_request_error',
          }),
        );
      }
      if (method === 'GET' && path === '/v1/privacy/redaction_jobs') {
        return Promise.resolve({
          data: [
            { id: 'prj_dead', status: 'canceled', objects: { customers: ['cus_1'] } },
            { id: 'prj_other', status: 'ready', objects: { customers: ['cus_9'] } },
            { id: 'prj_live', status: 'ready', objects: { customers: ['cus_1'] } },
          ],
        });
      }
      if (method === 'GET') return Promise.resolve({ id: 'prj_live', status: 'ready' });
      return Promise.resolve({ id: 'prj_live' });
    });

    await redactStripeCustomers(ORG_ID, deletionRecord(), CUSTOMERS);

    // The live job containing the customer is recovered (terminal/other-
    // customer jobs skipped), persisted, and driven to run.
    expect(rawRequestCalls()).toEqual([
      'POST /v1/privacy/redaction_jobs',
      'GET /v1/privacy/redaction_jobs',
      'GET /v1/privacy/redaction_jobs/prj_live',
      'POST /v1/privacy/redaction_jobs/prj_live/run',
    ]);
    expect(jobIdWrites()[0].args[0].input.ExpressionAttributeValues?.[':jobId']?.S).toBe(
      'prj_live',
    );
  });

  it('throws when the conflicting job cannot be found in the list', async () => {
    mockRawRequest.mockImplementation((method: string, path: string) => {
      if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
        return Promise.reject(new Error('Customer cus_1 is already included in a redaction job.'));
      }
      return Promise.resolve({ data: [] });
    });

    await expect(redactStripeCustomers(ORG_ID, deletionRecord(), CUSTOMERS)).rejects.toThrow(
      /no live job containing them was found/,
    );
  });

  it('surfaces a failed redaction job so the stuck gauge catches it', async () => {
    stubRedactionJob('failed');

    await expect(
      redactStripeCustomers(ORG_ID, deletionRecord({ stripeRedactionJobId: 'prj_1' }), CUSTOMERS),
    ).rejects.toThrow(/unexpected status "failed"/);
  });
});
