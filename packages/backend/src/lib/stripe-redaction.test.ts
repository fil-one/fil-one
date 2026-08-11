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
const CUSTOMER = 'cus_1';

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
    // Real jobs report the objects they cover; the stored-id path checks it.
    if (method === 'GET') {
      return Promise.resolve({
        id: 'prj_1',
        status: statusOnGet,
        objects: { customers: [CUSTOMER] },
      });
    }
    return Promise.resolve({ id: 'prj_1' });
  });
}

function rawRequestCalls() {
  return mockRawRequest.mock.calls.map(([method, path]) => `${method} ${path}`);
}

function jobIdWrites() {
  return ddbMock
    .commandCalls(UpdateItemCommand)
    .filter((c) => c.args[0].input.UpdateExpression?.includes('stripeRedactionJobIds.#cid'));
}

/** Terminal redaction statuses persisted on the DELETION record this pass. */
function statusWrites(): { customerId?: string; status?: string }[] {
  return ddbMock
    .commandCalls(UpdateItemCommand)
    .map((c) => c.args[0].input)
    .filter((input) => input.UpdateExpression?.includes('stripeRedactionJobStatuses.#cid'))
    .map((input) => ({
      customerId: input.ExpressionAttributeNames?.['#cid'],
      status: input.ExpressionAttributeValues?.[':status']?.S,
    }));
}

describe('redactStripeCustomers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock.on(GetItemCommand).resolves({ Item: deletionItem() });
    stubRedactionJob();
  });

  it('is a no-op when discovery found no customer', async () => {
    await redactStripeCustomers(ORG_ID, deletionRecord(), []);

    expect(mockRawRequest).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it("creates the job for the org's customer, persists its id, validates and runs it", async () => {
    await redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER]);

    expect(mockRawRequest).toHaveBeenCalledWith('POST', '/v1/privacy/redaction_jobs', {
      objects: { customers: ['cus_1'] },
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
    await redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER]);

    expect(jobIdWrites()[0].args[0].input.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(stripeRedactionJobIds.#cid)',
    );
    // Keyed by the customer the job covers, so a second customer discovered by
    // a resweep gets its OWN job instead of reading as "already have one".
    expect(jobIdWrites()[0].args[0].input.ExpressionAttributeNames?.['#cid']).toBe(CUSTOMER);
  });

  it('throws on a not-yet-ready job, then advances the SAME job on re-entry without re-creating', async () => {
    stubRedactionJob('validating');

    await expect(redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER])).rejects.toThrow(
      /not ready yet/,
    );

    // Re-entry with the persisted id: the job is fetched and run, never re-created.
    mockRawRequest.mockClear();
    stubRedactionJob('ready');

    await redactStripeCustomers(
      ORG_ID,
      deletionRecord({ stripeRedactionJobIds: { [CUSTOMER]: 'prj_1' } }),
      [CUSTOMER],
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
      deletionRecord({ stripeRedactionJobIds: { [CUSTOMER]: 'prj_1' } }),
      [CUSTOMER],
    );

    expect(rawRequestCalls()).toEqual(['GET /v1/privacy/redaction_jobs/prj_1']);
  });

  it('does NOT let a stored job covering a different customer short-circuit this one (resweep)', async () => {
    // The resurrection case: a completed teardown's job covers cus_1, and a
    // post-purge createBillingTrial minted cus_2. Coverage is asked of Stripe
    // rather than assumed, so cus_2 never reads as "already redacted" — that is
    // what left a resurrected customer's PII in Stripe forever.
    mockRawRequest.mockImplementation((method: string, path: string) => {
      if (path === '/v1/privacy/redaction_jobs/prj_1') {
        return Promise.resolve({ id: 'prj_1', status: 'ready', objects: { customers: ['cus_1'] } });
      }
      if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
        return Promise.resolve({ id: 'prj_2', status: 'created' });
      }
      if (method === 'GET') {
        return Promise.resolve({ id: 'prj_2', status: 'ready', objects: { customers: ['cus_2'] } });
      }
      return Promise.resolve({ id: 'prj_2' });
    });

    await redactStripeCustomers(
      ORG_ID,
      deletionRecord({ stripeRedactionJobIds: { cus_2: 'prj_1' } }),
      ['cus_2'],
    );

    expect(mockRawRequest).toHaveBeenCalledWith('POST', '/v1/privacy/redaction_jobs', {
      objects: { customers: ['cus_2'] },
    });
    expect(rawRequestCalls()).toEqual([
      // The stored id is checked against Stripe rather than assumed to cover
      // whoever is being redacted.
      'GET /v1/privacy/redaction_jobs/prj_1',
      'POST /v1/privacy/redaction_jobs',
      'POST /v1/privacy/redaction_jobs/prj_2/validate',
      'GET /v1/privacy/redaction_jobs/prj_2',
      'POST /v1/privacy/redaction_jobs/prj_2/run',
    ]);
    // The fresh id is swapped in against the id proven unusable. Requiring an
    // EMPTY slot here would make the write impossible and send the pass straight
    // back to driving prj_1.
    const write = jobIdWrites()[0].args[0].input;
    expect(write.ExpressionAttributeNames?.['#cid']).toBe('cus_2');
    expect(write.ConditionExpression).toBe(
      'attribute_exists(pk) AND stripeRedactionJobIds.#cid = :replacing',
    );
    expect(write.ExpressionAttributeValues?.[':replacing']?.S).toBe('prj_1');
    expect(write.ExpressionAttributeValues?.[':jobId']?.S).toBe('prj_2');
  });

  it('replaces a stored job Stripe no longer has instead of wedging on it', async () => {
    // The branch fetchRedactionJob exists for: a GET that 404s must not
    // propagate, or every later pass repeats the same failure forever.
    mockRawRequest.mockImplementation((method: string, path: string) => {
      if (path === '/v1/privacy/redaction_jobs/prj_gone') {
        return Promise.reject(
          Object.assign(new Error('No such redaction job'), { code: 'resource_missing' }),
        );
      }
      if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
        return Promise.resolve({ id: 'prj_new', status: 'created' });
      }
      if (method === 'GET') {
        return Promise.resolve({
          id: 'prj_new',
          status: 'ready',
          objects: { customers: [CUSTOMER] },
        });
      }
      return Promise.resolve({ id: 'prj_new' });
    });

    await redactStripeCustomers(
      ORG_ID,
      deletionRecord({ stripeRedactionJobIds: { [CUSTOMER]: 'prj_gone' } }),
      [CUSTOMER],
    );

    expect(rawRequestCalls()).toEqual([
      'GET /v1/privacy/redaction_jobs/prj_gone',
      'POST /v1/privacy/redaction_jobs',
      'POST /v1/privacy/redaction_jobs/prj_new/validate',
      'GET /v1/privacy/redaction_jobs/prj_new',
      'POST /v1/privacy/redaction_jobs/prj_new/run',
    ]);
    expect(jobIdWrites()[0].args[0].input.ExpressionAttributeValues?.[':replacing']?.S).toBe(
      'prj_gone',
    );
  });

  it('attempts every customer even when the first one throws', async () => {
    // A permanently failed job on the original customer must not leave a
    // resurrected customer with no redaction job at all.
    mockRawRequest.mockImplementation((method: string, path: string) => {
      if (path === '/v1/privacy/redaction_jobs/prj_bad') {
        return Promise.resolve({
          id: 'prj_bad',
          status: 'failed',
          objects: { customers: ['cus_1'] },
        });
      }
      if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
        return Promise.resolve({ id: 'prj_2', status: 'created' });
      }
      if (method === 'GET') {
        return Promise.resolve({ id: 'prj_2', status: 'ready', objects: { customers: ['cus_2'] } });
      }
      return Promise.resolve({ id: 'prj_2' });
    });

    await expect(
      redactStripeCustomers(
        ORG_ID,
        deletionRecord({ stripeRedactionJobIds: { cus_1: 'prj_bad' } }),
        ['cus_1', 'cus_2'],
      ),
    ).rejects.toThrow(/unexpected status "failed"/);

    // cus_2 still got its own job created and driven to run.
    expect(rawRequestCalls()).toContain('POST /v1/privacy/redaction_jobs/prj_2/run');
  });

  it('tolerates a missing customer at job creation', async () => {
    mockRawRequest.mockRejectedValue(
      Object.assign(new Error('No such customer'), { code: 'resource_missing' }),
    );

    await redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER]);

    expect(rawRequestCalls()).toEqual(['POST /v1/privacy/redaction_jobs']);
    expect(jobIdWrites()).toHaveLength(0);
  });

  it('does not treat a message-only "already redacted" error as success (must be resource_missing)', async () => {
    mockRawRequest.mockRejectedValue(new Error('This customer was already redacted elsewhere'));

    await expect(redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER])).rejects.toThrow(
      /already redacted elsewhere/,
    );
  });

  it('persists the job id conditionally and defers to a concurrently stored id', async () => {
    // Another worker stored prj_stored between our create and our write.
    ddbMock
      .on(UpdateItemCommand, {
        ConditionExpression:
          'attribute_exists(pk) AND attribute_not_exists(stripeRedactionJobIds.#cid)',
      })
      .rejects(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
    ddbMock
      .on(GetItemCommand)
      .resolves({ Item: deletionItem({ stripeRedactionJobIds: { [CUSTOMER]: 'prj_stored' } }) });
    mockRawRequest.mockImplementation((method: string, path: string) => {
      if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
        return Promise.resolve({ id: 'prj_mine', status: 'created' });
      }
      if (method === 'GET') {
        return Promise.resolve({
          id: 'prj_stored',
          status: 'ready',
          objects: { customers: [CUSTOMER] },
        });
      }
      return Promise.resolve({ id: 'prj_stored' });
    });

    await redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER]);

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
        ConditionExpression:
          'attribute_exists(pk) AND attribute_not_exists(stripeRedactionJobIds.#cid)',
      })
      .rejects(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    await expect(redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER])).rejects.toThrow(
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
      if (method === 'GET') {
        return Promise.resolve({
          id: 'prj_live',
          status: 'ready',
          objects: { customers: [CUSTOMER] },
        });
      }
      return Promise.resolve({ id: 'prj_live' });
    });

    await redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER]);

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

  it('pages the redaction-job list to find a conflicting job past the first page', async () => {
    // Jobs are account-wide and one is created per org deletion, so the list
    // grows past a single page after ~100 deletions. Unpaginated, the live
    // conflicting job fell off page 1, the throw fired on every retry, and that
    // teardown wedged permanently.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `prj_p1_${i}`,
      status: 'ready',
      objects: { customers: [`cus_other_${i}`] },
    }));
    mockRawRequest.mockImplementation(
      (method: string, path: string, params?: Record<string, unknown>) => {
        if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
          return Promise.reject(
            new Error('Customer cus_1 is already included in a redaction job.'),
          );
        }
        if (method === 'GET' && path === '/v1/privacy/redaction_jobs') {
          return params?.starting_after
            ? Promise.resolve({
                data: [{ id: 'prj_live', status: 'ready', objects: { customers: ['cus_1'] } }],
                has_more: false,
              })
            : Promise.resolve({ data: page1, has_more: true });
        }
        if (method === 'GET') {
          return Promise.resolve({
            id: 'prj_live',
            status: 'ready',
            objects: { customers: [CUSTOMER] },
          });
        }
        return Promise.resolve({ id: 'prj_live' });
      },
    );

    await redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER]);

    // Page 2 was requested with the last id of page 1 as the cursor.
    const listCalls = mockRawRequest.mock.calls.filter(
      ([method, path]) => method === 'GET' && path === '/v1/privacy/redaction_jobs',
    );
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0][2]).toEqual({ limit: 100 });
    expect(listCalls[1][2]).toEqual({ limit: 100, starting_after: 'prj_p1_99' });
    expect(jobIdWrites()[0].args[0].input.ExpressionAttributeValues?.[':jobId']?.S).toBe(
      'prj_live',
    );
  });

  it('fails loudly rather than concluding "not found" when the page walk is exhausted', async () => {
    // Stripe says a live job contains the customer, so an exhausted walk is an
    // unanswered question, never an answer of "no such job".
    mockRawRequest.mockImplementation((method: string, path: string) => {
      if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
        return Promise.reject(new Error('Customer cus_1 is already included in a redaction job.'));
      }
      return Promise.resolve({
        data: [{ id: 'prj_x', status: 'ready', objects: { customers: ['cus_other'] } }],
        has_more: true,
      });
    });

    await expect(redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER])).rejects.toThrow(
      /was not found within 100 pages/,
    );
  });

  it('throws when the conflicting job cannot be found in the list', async () => {
    mockRawRequest.mockImplementation((method: string, path: string) => {
      if (method === 'POST' && path === '/v1/privacy/redaction_jobs') {
        return Promise.reject(new Error('Customer cus_1 is already included in a redaction job.'));
      }
      return Promise.resolve({ data: [] });
    });

    await expect(redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER])).rejects.toThrow(
      /no live job containing them was found/,
    );
  });

  it('surfaces a failed redaction job so the stuck gauge catches it', async () => {
    stubRedactionJob('failed');

    await expect(
      redactStripeCustomers(
        ORG_ID,
        deletionRecord({ stripeRedactionJobIds: { [CUSTOMER]: 'prj_1' } }),
        [CUSTOMER],
      ),
    ).rejects.toThrow(/unexpected status "failed"/);
  });

  // A resweep's record is already DONE and its purge deletes the rows the
  // resurrection sweep detects orgs by, so these persisted statuses are the
  // only thing that keeps an unfinished job being driven — and the only thing
  // that ever stops the driving. See lib/deletion-resurrection-sweep.ts.
  describe('terminal status persistence', () => {
    it('records `redacting` the moment it runs the job, not on some later pass', async () => {
      await redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER]);

      expect(statusWrites()).toEqual([{ customerId: CUSTOMER, status: 'redacting' }]);
    });

    it('records an already-succeeded job', async () => {
      stubRedactionJob('succeeded');

      await redactStripeCustomers(
        ORG_ID,
        deletionRecord({ stripeRedactionJobIds: { [CUSTOMER]: 'prj_1' } }),
        [CUSTOMER],
      );

      expect(statusWrites()).toEqual([{ customerId: CUSTOMER, status: 'succeeded' }]);
    });

    it('records nothing while the job is still short of `ready`', async () => {
      stubRedactionJob('validating');

      await expect(
        redactStripeCustomers(
          ORG_ID,
          deletionRecord({ stripeRedactionJobIds: { [CUSTOMER]: 'prj_1' } }),
          [CUSTOMER],
        ),
      ).rejects.toThrow(/not ready yet/);

      // Non-terminal: the org must keep being re-driven.
      expect(statusWrites()).toEqual([]);
    });

    it('records a terminal FAILURE — the loop has to stop, the gauge takes over', async () => {
      stubRedactionJob('failed');

      await expect(
        redactStripeCustomers(
          ORG_ID,
          deletionRecord({ stripeRedactionJobIds: { [CUSTOMER]: 'prj_1' } }),
          [CUSTOMER],
        ),
      ).rejects.toThrow(/unexpected status "failed"/);

      expect(statusWrites()).toEqual([{ customerId: CUSTOMER, status: 'failed' }]);
    });

    it('does NOT record a status it does not recognise: unknown is not terminal', async () => {
      stubRedactionJob('some_new_stripe_status');

      await expect(
        redactStripeCustomers(
          ORG_ID,
          deletionRecord({ stripeRedactionJobIds: { [CUSTOMER]: 'prj_1' } }),
          [CUSTOMER],
        ),
      ).rejects.toThrow(/unexpected status "some_new_stripe_status"/);

      expect(statusWrites()).toEqual([]);
    });

    it('records `unavailable` for a customer Stripe no longer has', async () => {
      // Nothing left to redact and no later pass could differ, so this has to
      // be terminal or the org is re-driven for it forever.
      mockRawRequest.mockRejectedValue(
        Object.assign(new Error('No such customer'), { code: 'resource_missing' }),
      );

      await redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER]);

      expect(statusWrites()).toEqual([{ customerId: CUSTOMER, status: 'unavailable' }]);
    });

    it('says which record is missing instead of throwing a bare ConditionalCheckFailedException', async () => {
      ddbMock
        .on(UpdateItemCommand)
        .rejects(new ConditionalCheckFailedException({ message: 'gone', $metadata: {} }));

      await expect(redactStripeCustomers(ORG_ID, deletionRecord(), [CUSTOMER])).rejects.toThrow(
        /rejected redaction job id prj_1 for customer cus_1 but no stored id was found on re-read/,
      );
    });
  });
});
