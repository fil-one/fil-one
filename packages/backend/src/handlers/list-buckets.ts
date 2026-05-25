import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ListBucketsResponse } from '@filone/shared';
import { getAvailableOrchestrators } from '../lib/service-orchestrator-registry.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);

  const orchestrators = getAvailableOrchestrators(process.env.FILONE_STAGE!);
  const results = await Promise.all(
    orchestrators.map(async (orchestrator) => {
      const tenantId = await orchestrator.isTenantReady(orgId);
      if (!tenantId) return [];
      return orchestrator.listBuckets(tenantId);
    }),
  );
  const buckets = results.flat();
  return new ResponseBuilder().status(200).body<ListBucketsResponse>({ buckets }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
