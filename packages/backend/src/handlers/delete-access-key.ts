import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { type ErrorResponse, S3Region } from '@filone/shared';
import { Resource } from 'sst';
import { userActor } from '../lib/audit.ts';
import { getDynamoClient } from '../lib/ddb-client.ts';
import { AccessKeyKeys, DEFAULT_ACCESS_KEY_REGION } from '../lib/dynamo-records.ts';
import { keyScope, notYourKeyResponse, withinScope } from '../lib/key-scope.ts';
import { revokeAccessKey } from '../lib/key-revocation.ts';
import { ResponseBuilder, tenantNotReadyResponse } from '../lib/response-builder.ts';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import { getOrgProfile } from '../lib/org-profile.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

const dynamo = getDynamoClient();

export async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const keyId = event.pathParameters?.keyId;
  if (!keyId) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing keyId in path' })
      .build();
  }

  const { orgId, userId } = getUserInfo(event);
  const rowKey = marshall({ pk: AccessKeyKeys.orgPk(orgId), sk: AccessKeyKeys.keySk(keyId) });

  // Two reads neither of which depends on the other: the key's row and the org
  // profile the tenant id comes from. Sequentially they were two round trips on
  // the path of every revocation.
  const [{ Item }, orgProfile] = await Promise.all([
    dynamo.send(new GetItemCommand({ TableName: Resource.UserInfoTable.name, Key: rowKey })),
    getOrgProfile(orgId),
  ]);

  if (!Item) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Access key not found' })
      .build();
  }

  // Revoking is `keys.manage_own` unless the caller holds `keys.manage_all`, so
  // a Member revokes the keys they minted and no others. Checked before the
  // orchestrator is touched: the provider-side deletion is the irreversible
  // half.
  if (
    !withinScope(keyScope(event), { createdBy: Item.createdBy?.S, recovered: Item.recovered?.BOOL })
  )
    return notYourKeyResponse();

  const region: S3Region = (Item.region?.S as S3Region | undefined) ?? DEFAULT_ACCESS_KEY_REGION;
  const orchestrator = getOrchestratorForRegion(region);

  const tenantId = orchestrator.isTenantReady(orgProfile);
  if (!tenantId) return tenantNotReadyResponse();

  // The member is revoking their own key, which is the one revocation somebody
  // asked for directly. The passes that take a key its holder did not ask about
  // name themselves instead.
  await revokeAccessKey({
    orgId,
    keyId,
    accessKeyId: Item.accessKeyId?.S,
    keyName: Item.keyName?.S,
    region,
    orchestrator,
    tenantId,
    actor: userActor({ userId, email: getVerifiedEmail(event) }),
    reason: 'user_requested',
  });

  return { statusCode: 204, body: '' };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('keys.manage_own'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
