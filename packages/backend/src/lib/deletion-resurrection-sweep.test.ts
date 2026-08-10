import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchGetItemCommand,
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
    RagIndexerTable: { name: 'RagIndexerTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { sweepResurrectedOrgs } from './deletion-resurrection-sweep.js';

/** Far enough ahead that the org-partition probes always run. */
const NO_DEADLINE = () => Date.now() + 60_000;

/** An `ORG#{orgId}` partition holding only the retained DELETION audit row. */
function purgedPartition() {
  return { Items: [marshall({ sk: 'DELETION' })] };
}

/** A candidate org; `pending` defaults to "no outstanding Stripe redaction". */
function candidate(orgId: string, userIds: string[] = [], pending: string[] = []) {
  return { orgId, userIds, pendingRedactionCustomerIds: pending };
}

describe('sweepResurrectedOrgs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(BatchGetItemCommand).resolves({ Responses: { BillingTable: [] } });
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(QueryCommand).resolves(purgedPartition());
  });

  it('does no I/O at all when the window holds no candidates', async () => {
    const result = await sweepResurrectedOrgs({
      candidates: [],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    expect(result).toEqual({ resurrected: [], skipped: 0, ragIndexTruncated: false });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('reports nothing for orgs whose every surface is clean', async () => {
    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', ['user-a'])],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    expect(result.resurrected).toEqual([]);
  });

  it('batches every candidate’s member keys into ONE cross-org BatchGetItem', async () => {
    await sweepResurrectedOrgs({
      candidates: [candidate('org-a', ['user-a1', 'user-a2']), candidate('org-b', ['user-b1'])],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    const batches = ddbMock.commandCalls(BatchGetItemCommand);
    expect(batches).toHaveLength(1);
    expect(batches[0].args[0].input.RequestItems!.BillingTable.Keys).toEqual([
      marshall({ pk: 'CUSTOMER#user-a1', sk: 'SUBSCRIPTION' }),
      marshall({ pk: 'CUSTOMER#user-a2', sk: 'SUBSCRIPTION' }),
      marshall({ pk: 'CUSTOMER#user-b1', sk: 'SUBSCRIPTION' }),
    ]);
  });

  it('attributes a surviving billing row back to the org that owned the member', async () => {
    ddbMock.on(BatchGetItemCommand).resolves({
      Responses: { BillingTable: [marshall({ pk: 'CUSTOMER#user-b1', sk: 'SUBSCRIPTION' })] },
    });

    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', ['user-a1']), candidate('org-b', ['user-b1'])],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    expect(result.resurrected).toEqual([
      {
        orgId: 'org-b',
        surfaces: ['billing'],
        userIds: ['user-b1'],
        pendingRedactionCustomerIds: [],
      },
    ]);
  });

  it('ignores the retained DELETION audit row but reports any other ORG# row', async () => {
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ':pk': { S: 'ORG#org-b' } } })
      .resolves({ Items: [marshall({ sk: 'DELETION' }), marshall({ sk: 'ACCESSKEY#key-1' })] });

    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', []), candidate('org-b', [])],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    expect(result.resurrected).toEqual([
      { orgId: 'org-b', surfaces: ['orgRows'], userIds: [], pendingRedactionCustomerIds: [] },
    ]);
  });

  it('pages the org-partition probe rather than judging from the first page', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [marshall({ sk: 'DELETION' })], LastEvaluatedKey: marshall({}) })
      .resolves({ Items: [marshall({ sk: 'RAGKEY#key-1' })] });

    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', [])],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
    expect(result.resurrected[0].surfaces).toEqual(['orgRows']);
  });

  it('reports a per-bucket RAG enablement row that outlived the teardown', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [marshall({ pk: 'BUCKET#org-a#us-east-1#bucket-1', orgId: 'org-a' })],
    });

    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', [])],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    expect(result.resurrected[0].surfaces).toEqual(['ragIndex']);
  });

  it('falls back to the bucket pk for an enablement row carrying no orgId', async () => {
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [marshall({ pk: 'BUCKET#org-a#us-east-1#bucket-1' })] });

    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', [])],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    expect(result.resurrected[0].surfaces).toEqual(['ragIndex']);
  });

  it('leaves RAG rows belonging to a live org alone', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [marshall({ pk: 'BUCKET#org-live#us-east-1#bucket-1', orgId: 'org-live' })],
    });

    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', [])],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    expect(result.resurrected).toEqual([]);
  });

  it('reports a RAGKEYHASH# lookup row the caller harvested from its own scan', async () => {
    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', [])],
      ragKeyHashOrgIds: new Set(['org-a', 'org-not-a-candidate']),
      deadline: NO_DEADLINE(),
    });

    expect(result.resurrected).toEqual([
      { orgId: 'org-a', surfaces: ['ragKeyHash'], userIds: [], pendingRedactionCustomerIds: [] },
    ]);
  });

  it('names every surface that carried rows, not just the first', async () => {
    ddbMock.on(BatchGetItemCommand).resolves({
      Responses: { BillingTable: [marshall({ pk: 'CUSTOMER#user-a1', sk: 'SUBSCRIPTION' })] },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [marshall({ sk: 'PROFILE' })] });

    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', ['user-a1'])],
      ragKeyHashOrgIds: new Set(['org-a']),
      deadline: NO_DEADLINE(),
    });

    expect(result.resurrected[0].surfaces).toEqual(['billing', 'orgRows', 'ragKeyHash']);
  });

  it('reports an unfinished redaction as its own surface, with every row surface clean', async () => {
    // The case a resweep creates and then destroys the evidence for: it holds
    // the Stripe failure so the purge can run, so on the NEXT run every row
    // surface is clean while the resurrected customer is still un-redacted.
    // Without this surface the org drops off the sweep and its PII stays.
    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', ['user-a1'], ['cus_resurrected'])],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    expect(result.resurrected).toEqual([
      {
        orgId: 'org-a',
        surfaces: ['stripeRedaction'],
        userIds: [],
        pendingRedactionCustomerIds: ['cus_resurrected'],
      },
    ]);
  });

  it('stops reporting the org once every redaction job has settled', async () => {
    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', ['user-a1'], [])],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    expect(result.resurrected).toEqual([]);
  });

  it('reports the redaction surface even when every probe was skipped on the deadline', async () => {
    // It is answered from the candidate, not a round trip, so a budget-starved
    // run must not read as "nothing outstanding".
    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', ['user-a1'], ['cus_resurrected'])],
      ragKeyHashOrgIds: new Set(),
      deadline: Date.now() - 1,
    });

    expect(result.resurrected[0].surfaces).toEqual(['stripeRedaction']);
  });

  it('skips the per-org probes once the deadline has passed, and says how many', async () => {
    ddbMock.on(BatchGetItemCommand).resolves({
      Responses: { BillingTable: [marshall({ pk: 'CUSTOMER#user-a1', sk: 'SUBSCRIPTION' })] },
    });

    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', ['user-a1']), candidate('org-b', [])],
      ragKeyHashOrgIds: new Set(),
      deadline: Date.now() - 1,
    });

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(result.skipped).toBe(2);
    // Only the billing BatchGet is genuinely bounded, so only it still runs.
    expect(result.resurrected[0].surfaces).toEqual(['billing']);
  });

  it('stops paging the RagIndexerTable scan on the deadline and reports the lost coverage', async () => {
    // RagIndexerTable is the high-churn indexer store and a Scan reads every
    // item regardless of the FilterExpression, so an unbounded walk here eats
    // the 300s Lambda before a single resweep is invoked — M7's starvation,
    // moved to another table. Truncating is reported, never read as "clean".
    ddbMock.on(ScanCommand).resolves({
      Items: [marshall({ pk: 'BUCKET#org-a#us-east-1#bucket-1', orgId: 'org-a' })],
      LastEvaluatedKey: marshall({ pk: 'BUCKET#org-a#us-east-1#bucket-1', sk: 'RAG' }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await sweepResurrectedOrgs({
        candidates: [candidate('org-a', [])],
        ragKeyHashOrgIds: new Set(),
        deadline: Date.now() + 20,
      });

      // Would page forever on LastEvaluatedKey without the deadline.
      expect(result.ragIndexTruncated).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Budget expired mid-scan of RagIndexerTable'),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reports the RagIndexerTable scan as complete when it finishes inside the budget', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = await sweepResurrectedOrgs({
      candidates: [candidate('org-a', [])],
      ragKeyHashOrgIds: new Set(),
      deadline: NO_DEADLINE(),
    });

    expect(result.ragIndexTruncated).toBe(false);
  });

  it('a failing billing probe does not suppress the surfaces that succeeded', async () => {
    ddbMock.on(BatchGetItemCommand).rejects(new Error('DynamoDB unavailable'));
    ddbMock.on(QueryCommand).resolves({ Items: [marshall({ sk: 'PROFILE' })] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await sweepResurrectedOrgs({
        candidates: [candidate('org-a', ['user-a1'])],
        ragKeyHashOrgIds: new Set(),
        deadline: NO_DEADLINE(),
      });

      expect(result.resurrected[0].surfaces).toEqual(['orgRows']);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('those surfaces are unchecked this run'),
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  }, 15000);

  it('a failing org probe skips that org without aborting the rest', async () => {
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ':pk': { S: 'ORG#org-a' } } })
      .rejects(new Error('DynamoDB unavailable'));
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ':pk': { S: 'ORG#org-b' } } })
      .resolves({ Items: [marshall({ sk: 'PROFILE' })] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await sweepResurrectedOrgs({
        candidates: [candidate('org-a', []), candidate('org-b', [])],
        ragKeyHashOrgIds: new Set(),
        deadline: NO_DEADLINE(),
      });

      expect(result.resurrected).toEqual([
        { orgId: 'org-b', surfaces: ['orgRows'], userIds: [], pendingRedactionCustomerIds: [] },
      ]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to probe the org partition'),
        expect.objectContaining({ orgId: 'org-a' }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
