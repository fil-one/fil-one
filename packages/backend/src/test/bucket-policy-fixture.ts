// Shared fixture for the three bucket-policy handler tests: an `iam` region
// served by the in-memory fake, and a `service-keys` region beside it.
import { vi } from 'vitest';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { POLICY_VERSION, S3Region, toPolicyPrincipal } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';
import { FakeIamOrchestrator } from './fake-iam-orchestrator.ts';
import { fakeOrchestrator, tenantFor } from './fake-orchestrator.ts';

export const ORG_ID = '11111111-2222-3333-4444-555555555555';
export const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
/** The one region these tests treat as `iam`; no production region serves iam yet. */
export const IAM_REGION = S3Region.UsEast9;
export const SERVICE_KEYS_REGION = S3Region.EuWest1;
export const BUCKET_NAME = 'photos';

export const grantGetObjectToUser: BucketPolicy = {
  Version: POLICY_VERSION,
  Statement: [
    {
      Effect: 'Allow',
      Principal: toPolicyPrincipal([USER_ID]),
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${BUCKET_NAME}/*`],
    },
  ],
};

export const iam = new FakeIamOrchestrator();
export const orchestrator = fakeOrchestrator('forgeDev', { region: IAM_REGION, iam });
export const legacyOrchestrator = fakeOrchestrator('aurora', { region: SERVICE_KEYS_REGION });
/** The tenant the fake resolves for the test org. */
export const TENANT_ID = tenantFor('forgeDev', ORG_ID);
export const ensureTenantReady = vi.fn(async () => TENANT_ID);
export const isOrgDeleting = vi.fn(async () => false);

/** What the mocked registry answers: the `iam` fake for its region, a scoped one otherwise. */
export function getOrchestratorForRegion(region: string) {
  return region === IAM_REGION ? { ...orchestrator, ensureTenantReady } : legacyOrchestrator;
}

export const ddbMock = mockClient(DynamoDBClient);

/** The standalone audit events written, as records. */
export function getAuditEvents(): Array<
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
  iam.seedBucket(TENANT_ID, BUCKET_NAME);
  iam.seedPrincipal(TENANT_ID, USER_ID);
  ensureTenantReady.mockResolvedValue(TENANT_ID);
  isOrgDeleting.mockResolvedValue(false);
}
