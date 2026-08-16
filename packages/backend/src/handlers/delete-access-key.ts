import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { ErrorResponse, S3Region } from '@filone/shared';
import type { AuditActor } from '@filone/shared';
import { Resource } from 'sst';
import {
  AuditSubjects,
  appendAuditEvent,
  auditEvent,
  commitAudited,
  newCorrelationId,
} from '../lib/audit.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { keyScope, notYourKeyResponse, withinScope } from '../lib/key-scope.js';
import { ResponseBuilder, tenantNotReadyResponse } from '../lib/response-builder.js';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { getOrgProfile } from '../lib/org-profile.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

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
  const email = getVerifiedEmail(event);
  const actor: AuditActor = { kind: 'user', id: userId, ...(email ? { email } : {}) };

  // Verify the key belongs to this org
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: `ORG#${orgId}`, sk: `ACCESSKEY#${keyId}` }),
    }),
  );

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

  // Legacy rows written before multi-region routing don't carry a `region`
  // attribute — those predate FTH, so they belong to Aurora (eu-west-1).
  const region: S3Region = (Item.region?.S as S3Region | undefined) ?? S3Region.EuWest1;
  const orchestrator = getOrchestratorForRegion(region);

  const tenantId = orchestrator.isTenantReady(await getOrgProfile(orgId));
  if (!tenantId) return tenantNotReadyResponse();

  // Revocation happens at the vendor first and cannot join the local
  // transaction, so it gets the same intent/completion pair a mint does: an
  // intent that never completes says a credential was revoked at the vendor
  // while its local row may still be listed.
  const correlationId = newCorrelationId();
  const keyName = Item.keyName?.S;
  const details = { keyKind: 's3' as const, region, ...(keyName ? { keyName } : {}) };

  await appendAuditEvent(
    auditEvent({
      type: 'key.revoked',
      phase: 'intent',
      correlationId,
      actor,
      orgId,
      subject: AuditSubjects.key(keyId),
      details,
    }),
  );

  await orchestrator.deleteAccessKey(tenantId, keyId);

  await commitAudited({
    items: [
      {
        Delete: {
          TableName: Resource.UserInfoTable.name,
          Key: marshall({ pk: `ORG#${orgId}`, sk: `ACCESSKEY#${keyId}` }),
        },
      },
    ],
    event: auditEvent({
      type: 'key.revoked',
      phase: 'completion',
      correlationId,
      actor,
      orgId,
      subject: AuditSubjects.key(keyId),
      details,
    }),
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
