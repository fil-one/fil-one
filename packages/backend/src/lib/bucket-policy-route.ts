// What the three bucket-policy routes share: resolving the bucket and region
// the request names, deciding whether the region serves policies at all, and
// turning the orchestrator's refusals into the console's answers.

import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, S3_REGION, isSupportedRegion, type S3Region } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import {
  BucketNotFoundError,
  PolicyConflictError,
  PolicyNotFoundError,
  PolicyPreconditionFailedError,
  PolicyPublishError,
  PolicyValidationError,
  PrincipalNotFoundError,
} from './errors.ts';
import { isOrgDeleting } from './org-profile.ts';
import {
  accountDeletedResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from './response-builder.ts';
import { getOrchestratorForRegion } from './service-orchestrator-registry.ts';
import type { IamOrchestrator } from './service-orchestrator.ts';
import type { AuthenticatedEvent } from './user-context.ts';

/** The bucket and region a policy route is about. */
export interface PolicyRouteTarget {
  bucketName: string;
  region: S3Region;
}

/**
 * The bucket from the path and the region from the query, or the 400 that says
 * which is missing.
 */
export function resolvePolicyRouteTarget(
  event: AuthenticatedEvent,
): { target: PolicyRouteTarget } | { response: APIGatewayProxyStructuredResultV2 } {
  const bucketName = event.pathParameters?.name;
  if (!bucketName) {
    return {
      response: new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({ message: 'Bucket name is required' })
        .build(),
    };
  }

  const region = event.queryStringParameters?.region ?? S3_REGION;
  if (!isSupportedRegion(region, process.env.FILONE_STAGE!)) {
    return { response: unsupportedRegionResponse(region) };
  }

  return { target: { bucketName, region } };
}

/**
 * The answer for a region that does not serve the `iam` access model: it has
 * no policies, and says so as a bucket with none rather than revealing a
 * feature that is not there. Read off the orchestrator, which the registry
 * hands the shared `getRegionAccessModel` answer, so this is what keeps the
 * routes dark while every region is `scoped-keys`.
 */
export const POLICIES_UNAVAILABLE_MESSAGE = 'Bucket policies are not available in this region';

/**
 * What a policy write needs before it reaches the vendor: the region's `iam`
 * orchestrator and the org's tenant on it, provisioning if need be. The
 * deletion fence runs first, as every write path has it: the write lands
 * upstream, so a fence checked only afterwards would leave it behind.
 */
export async function resolveIamWriteTarget(
  orgId: string,
  region: S3Region,
): Promise<
  | { orchestrator: IamOrchestrator; tenantId: string }
  | { response: APIGatewayProxyStructuredResultV2 }
> {
  const orchestrator = getOrchestratorForRegion(region);
  if (orchestrator.accessModel !== 'iam') {
    return { response: policyNotFoundResponse(POLICIES_UNAVAILABLE_MESSAGE) };
  }
  if (await isOrgDeleting(orgId, { consistent: true }))
    return { response: accountDeletedResponse() };
  const tenantId = await orchestrator.ensureTenantReady(orgId);
  if (!tenantId) return { response: tenantNotReadyResponse() };
  return { orchestrator, tenantId };
}

export function policyNotFoundResponse(
  message = 'This bucket has no policy',
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(404)
    .body<ErrorResponse>({ message, code: ApiErrorCode.POLICY_NOT_FOUND })
    .build();
}

export function bucketNotFoundResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(404)
    .body<ErrorResponse>({ message: 'Bucket not found' })
    .build();
}

/**
 * The stored policy moved under the caller. Both a stale ETag and a lock that
 * could not be taken within the storage system's timeout answer the same way:
 * nothing was written, and the remedy is to read the policy again and apply
 * the edit to what is there now.
 */
export function policyConflictResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'This policy changed while you were editing it. Reload it and try again.',
      code: ApiErrorCode.POLICY_CONFLICT,
    })
    .build();
}

/**
 * The console's answer to each refusal the orchestrator's `iam` arm can raise,
 * or undefined for an error that is not one of them, which the caller rethrows
 * into the generic 500.
 *
 * A failed publish is a 503 rather than a 500: the storage system committed
 * nothing and the same request may be sent again, which is what a 503 tells a
 * client and a 500 does not.
 */
export function bucketPolicyErrorResponse(
  err: unknown,
): APIGatewayProxyStructuredResultV2 | undefined {
  if (err instanceof PolicyNotFoundError) return policyNotFoundResponse();
  if (err instanceof BucketNotFoundError) return bucketNotFoundResponse();
  if (err instanceof PolicyPreconditionFailedError || err instanceof PolicyConflictError) {
    return policyConflictResponse();
  }
  if (err instanceof PolicyValidationError) {
    return new ResponseBuilder().status(400).body<ErrorResponse>({ message: err.message }).build();
  }
  // A member the storage system does not know: never synced, or removed since
  // the roster was read. The console re-reads the roster and asks again.
  if (err instanceof PrincipalNotFoundError) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'A member named in the policy is not known to this region.' })
      .build();
  }
  if (err instanceof PolicyPublishError) {
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({
        message: 'The storage system could not apply the policy change. Try again in a moment.',
      })
      .build();
  }
  return undefined;
}

/** How many distinct members a document names, for the audit record. Absent when only `*` is named. */
export function namedPrincipalCount(policy: {
  statement: readonly { principal: readonly string[] | '*' }[];
}): number | undefined {
  const ids = new Set<string>();
  for (const statement of policy.statement) {
    if (statement.principal === '*') continue;
    for (const id of statement.principal) ids.add(id);
  }
  return ids.size > 0 ? ids.size : undefined;
}
