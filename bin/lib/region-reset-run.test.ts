import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchWriteItemCommand, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { DeleteIndexCommand, S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { DeleteParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';

import type { AccountPlan, ResetPlan } from './region-reset.ts';
import { applyResetPlan, type RegionResetContext } from './region-reset-run.ts';

const dynamoMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);
const s3vectorsMock = mockClient(S3VectorsClient);

/** Every AWS command the apply loop sends and every step it runs, in order. */
let calls: string[];

const ctx: RegionResetContext = {
  stage: 'any-stage',
  region: 'eu-central-3',
  orchestratorId: 'forge',
  awsRegion: 'us-east-2',
  tables: { userInfo: 'filone-any-stage-UserInfo', ragIndexer: 'filone-any-stage-RagIndexer' },
  vectorBucket: 'filone-any-stage-rag-vectors',
  dynamo: new DynamoDBClient({ region: 'us-east-2' }),
  ssm: new SSMClient({ region: 'us-east-2' }),
  s3vectors: new S3VectorsClient({ region: 'us-east-2' }),
};

function account(orgId: string): AccountPlan {
  return {
    orgPk: `ORG#${orgId}`,
    orgId,
    tenantId: `${orgId}-tenant`,
    deleting: false,
    profileAttributes: {},
    accessKeys: [{ pk: { S: `ORG#${orgId}` }, sk: { S: 'ACCESSKEY#any-key' } }],
    ragBuckets: [
      {
        bucketName: 'any-bucket',
        indexName: 'any-index',
        rows: [{ pk: { S: 'BUCKET#any' }, sk: { S: 'RAG' } }],
      },
    ],
    ssmParameterNames: [`/filone/any-stage/forge-s3/access-key/${orgId}-tenant`],
  };
}

function plan(...accounts: AccountPlan[]): ResetPlan {
  return {
    stage: ctx.stage,
    region: ctx.region,
    orchestratorId: ctx.orchestratorId,
    tenantIdAttribute: 'forgeTenantId',
    vectorBucket: ctx.vectorBucket,
    accounts,
    notProvisioned: 0,
  };
}

async function failingStep(): Promise<void> {
  calls.push('beforeAccount');
  throw new Error('any upstream failure');
}

async function passingStep(): Promise<void> {
  calls.push('beforeAccount');
}

beforeEach(() => {
  calls = [];
  dynamoMock.reset();
  ssmMock.reset();
  s3vectorsMock.reset();
  s3vectorsMock.on(DeleteIndexCommand).callsFake(() => {
    calls.push('DeleteIndex');
    return {};
  });
  dynamoMock.on(BatchWriteItemCommand).callsFake(() => {
    calls.push('BatchWriteItem');
    return {};
  });
  ssmMock.on(DeleteParametersCommand).callsFake(({ Names }) => {
    calls.push('DeleteParameters');
    return { DeletedParameters: Names };
  });
  dynamoMock.on(UpdateItemCommand).callsFake(() => {
    calls.push('UpdateItem');
    return {};
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyResetPlan', () => {
  it('drops the index, then the rows and parameters, and clears the tenant link last', async () => {
    await applyResetPlan(ctx, plan(account('any-org')));
    expect(calls).toStrictEqual([
      'DeleteIndex',
      'BatchWriteItem',
      'BatchWriteItem',
      'DeleteParameters',
      'UpdateItem',
    ]);
  });

  it('runs the step before touching any of the account state', async () => {
    await applyResetPlan(ctx, plan(account('any-org')), passingStep);
    expect(calls[0]).toBe('beforeAccount');
  });

  it('sends nothing for an account whose step throws', async () => {
    await applyResetPlan(ctx, plan(account('any-org')), failingStep);
    expect(calls).toStrictEqual(['beforeAccount']);
  });

  it('records the account whose step throws, with the error message', async () => {
    const result = await applyResetPlan(ctx, plan(account('any-org')), failingStep);
    expect(result.failures).toStrictEqual([
      { orgPk: 'ORG#any-org', message: 'any upstream failure' },
    ]);
  });

  it('resets the next account after one whose step throws', async () => {
    let first = true;
    const failFirst = async () => {
      if (first) {
        first = false;
        return failingStep();
      }
      return passingStep();
    };
    const result = await applyResetPlan(
      ctx,
      plan(account('any-org'), account('another-org')),
      failFirst,
    );
    expect(result).toMatchObject({ clearedAccounts: 1, failures: [{ orgPk: 'ORG#any-org' }] });
  });
});
