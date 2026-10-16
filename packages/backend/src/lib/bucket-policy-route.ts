// What the three bucket-policy routes share: resolving the bucket and region
// the request names, deciding whether the region serves policies at all, and
// turning the orchestrator's refusals into the console's answers.

import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ApiErrorCode,
  S3_REGION,
  getNamedPrincipals,
  isSupportedRegion,
  supportsIamMethods,
  type S3Region,
} from '@filone/shared';
import type { BucketPolicy, ErrorResponse } from '@filone/shared';
import {
  BucketNotFoundError,
  PolicyConflictError,
  PolicyNotFoundError,
  PolicyPreconditionFailedError,
  PolicyPublishError,
  PolicyValidationError,
  PrincipalNotFoundError,
} from './errors.ts';
import type { PolicyPrecondition } from './bucket-policy-orchestrator.ts';
import { getOrgProfile, isOrgDeleting } from './org-profile.ts';
import { getRequestHeader } from './request-headers.ts';
import {
  accountDeletedResponse,
  badRequestResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from './response-builder.ts';
import { getOrchestratorForRegion } from './service-orchestrator-registry.ts';
import type { ServiceOrchestrator } from './service-orchestrator.ts';
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
 * The write's precondition from `If-Match` or `If-None-Match: *`, by the rules
 * S3 and the storage system apply: at most one, never empty, and
 * `If-None-Match` only as `*`. Neither means an unconditional write.
 */
export function parsePreconditionHeaders(
  event: AuthenticatedEvent,
):
  | { precondition: PolicyPrecondition | undefined }
  | { response: APIGatewayProxyStructuredResultV2 } {
  const ifMatch = getRequestHeader(event, 'If-Match');
  const ifNoneMatch = getRequestHeader(event, 'If-None-Match');
  if (ifMatch === '' || ifNoneMatch === '') {
    return { response: badRequestResponse('If-Match and If-None-Match cannot be empty') };
  }
  if (ifMatch !== undefined && ifNoneMatch !== undefined) {
    return { response: badRequestResponse('Send If-Match or If-None-Match, not both') };
  }
  if (ifNoneMatch !== undefined && ifNoneMatch !== '*') {
    return { response: badRequestResponse('If-None-Match must be *') };
  }
  if (ifMatch !== undefined) return { precondition: { ifMatch } };
  return { precondition: ifNoneMatch ? { ifNoneMatch: '*' } : undefined };
}

export const POLICIES_UNAVAILABLE_MESSAGE = 'Bucket policies are not available in this region';

/**
 * What a policy write needs before it reaches the vendor: the region's `iam`
 * orchestrator and the org's tenant on it. A policy belongs to a bucket, and a
 * bucket exists only on a tenant that is ready, so a write never provisions
 * one; an org with no tenant in the region gets the same 503 as a read. The
 * deletion fence runs first, as every write path has it: the write lands
 * upstream, so a fence checked only afterwards would leave it behind.
 */
export async function resolveIamWriteTarget(
  orgId: string,
  region: S3Region,
): Promise<
  | { orchestrator: ServiceOrchestrator; tenantId: string }
  | { response: APIGatewayProxyStructuredResultV2 }
> {
  if (!supportsIamMethods(region)) return { response: policiesUnavailableResponse() };
  // The region table says this orchestrator serves policies; the registry builds it as one.
  const orchestrator = getOrchestratorForRegion(region) as ServiceOrchestrator;
  if (await isOrgDeleting(orgId, { consistent: true }))
    return { response: accountDeletedResponse() };
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return { response: tenantNotReadyResponse() };
  return { orchestrator, tenantId };
}

/**
 * The answer on a region whose Forge network does not serve the `iam` access
 * model: the routes exist, but its storage system has no policies to serve.
 */
export function policiesUnavailableResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(501)
    .body<ErrorResponse>({ message: POLICIES_UNAVAILABLE_MESSAGE })
    .build();
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
 * The stored policy moved under the caller: a stale `If-Match` or an
 * `If-None-Match: *` that found a policy is a 412, and a lock that could not be
 * taken within the storage system's timeout a 409. Nothing was written either
 * way, and the remedy is to read the policy again and apply the edit to what is
 * there now.
 */
export function policyConflictResponse(status: 409 | 412): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(status)
    .body<ErrorResponse>({
      message: 'This policy changed while you were editing it. Reload it and try again.',
      code: ApiErrorCode.POLICY_CONFLICT,
    })
    .build();
}

/**
 * The console's answer to each refusal the orchestrator's bucket-policy
 * methods can raise, or undefined for an error that is not one of them, which
 * the caller rethrows into the generic 500.
 *
 * A failed publish is a 503 rather than a 500: the storage system committed
 * nothing and the same request may be sent again, which is what a 503 tells a
 * client and a 500 does not.
 */
export function toPolicyErrorResponse(err: unknown): APIGatewayProxyStructuredResultV2 | undefined {
  if (err instanceof PolicyNotFoundError) return policyNotFoundResponse();
  if (err instanceof BucketNotFoundError) return bucketNotFoundResponse();
  if (err instanceof PolicyPreconditionFailedError) return policyConflictResponse(412);
  if (err instanceof PolicyConflictError) return policyConflictResponse(409);
  if (err instanceof PolicyValidationError) {
    return new ResponseBuilder().status(400).body<ErrorResponse>({ message: err.message }).build();
  }
  // A member the storage system does not know: never synced, or removed since
  // the member list was read. The console re-reads the members and asks again.
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

/** How many distinct members a document names, for the audit record. Undefined when it names only `*`. */
export function countNamedPrincipals(policy: BucketPolicy): number | undefined {
  const count = new Set(getNamedPrincipals(policy)).size;
  return count > 0 ? count : undefined;
}
