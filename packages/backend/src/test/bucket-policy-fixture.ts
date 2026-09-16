// Shared fixture for the three bucket-policy handler tests: an `iam` region
// served by the in-memory fake, and a `scoped-keys` region beside it.
import { vi } from 'vitest';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Region } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';
import { FakeIamOrchestrator } from './fake-iam-orchestrator.ts';
import { fakeOrchestrator, tenantFor } from './fake-orchestrator.ts';

export const ORG_ID = '11111111-2222-3333-4444-555555555555';
export const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
/** The one region these tests treat as `iam`; every other region stays dark. */
export const IAM_REGION = S3Region.UsEast9;
export const SCOPED_REGION = S3Region.EuWest1;
export const BUCKET = 'photos';

export const readPolicy: BucketPolicy = {
  statement: [{ effect: 'allow', principal: [USER_ID], action: ['s3:GetObject'] }],
};

export const iam = new FakeIamOrchestrator();
export const orchestrator = fakeOrchestrator('forgeDev', { region: IAM_REGION, iam });
export const scopedOrchestrator = fakeOrchestrator('aurora', { region: SCOPED_REGION });
/** The tenant the fake resolves for the test org. */
export const TENANT_ID = tenantFor('forgeDev', ORG_ID);
export const ensureTenantReady = vi.fn(async () => TENANT_ID);
export const isOrgDeleting = vi.fn(async () => false);

/** What the mocked registry answers: the `iam` fake for its region, a scoped one otherwise. */
export function orchestratorForRegion(region: string) {
  return region === IAM_REGION ? { ...orchestrator, ensureTenantReady } : scopedOrchestrator;
}

export const ddbMock = mockClient(DynamoDBClient);

/** The standalone audit events written, as records. */
export function auditEvents(): Array<
  Record<string, unknown> & { details: Record<string, unknown> }
> {
  return ddbMock
    .commandCalls(PutItemCommand)
    .map((call) => unmarshall(call.args[0].input.Item ?? {}))
    .filter((item) => item.type) as Array<
    Record<string, unknown> & { details: Record<string, unknown> }
  >;
}

export function resetFixture(): void {
  vi.clearAllMocks();
  ddbMock.reset();
  ddbMock.on(PutItemCommand).resolves({});
  iam.principals.clear();
  iam.policies.clear();
  iam.buckets.clear();
  iam.calls.length = 0;
  iam.seedBucket(TENANT_ID, BUCKET);
  iam.seedPrincipal(TENANT_ID, USER_ID);
  ensureTenantReady.mockResolvedValue(TENANT_ID);
  isOrgDeleting.mockResolvedValue(false);
}
