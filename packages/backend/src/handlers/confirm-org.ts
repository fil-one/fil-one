import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ConfirmOrgRequest, ConfirmOrgResponse, ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import { createBillingTrial } from '../lib/create-billing-trial.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { triggerTenantSetup } from '../lib/trigger-tenant-setup.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { validateOrgName } from '../lib/org-name-validation.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, userId, email } = getUserInfo(event);
  const body = JSON.parse(event.body ?? '{}') as Partial<ConfirmOrgRequest>;

  // Validate and sanitize org name
  const result = validateOrgName(body.orgName);
  if (!result.valid) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: result.error! })
      .build();
  }

  // Update org profile: set name and mark as confirmed; return all attributes.
  // ConditionExpression ensures we don't accidentally upsert a missing org record.
  const { Attributes: updatedOrg } = await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
      UpdateExpression: 'SET #name = :name, orgConfirmed = :confirmed',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: {
        ':name': { S: result.sanitized },
        ':confirmed': { BOOL: true },
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  const setupStatus = updatedOrg?.setupStatus?.S;
  if (!isOrgSetupComplete(setupStatus)) {
    await triggerTenantSetup({ orgId, orgName: result.sanitized });
  }

  try {
    await createBillingTrial({ userId, orgId, email });
  } catch (error) {
    // Log billing trial creation failures but do not block org confirmation.
    console.error('[confirm-org] Failed to create billing trial for org confirmation', {
      error,
      orgId,
      userId,
      email,
    });
  }

  const responseBody: ConfirmOrgResponse = {
    orgId,
    orgName: result.sanitized,
  };

  return new ResponseBuilder().status(200).body(responseBody).build();
}

// This route is in the ORG_CONFIRM_BYPASS_ROUTES allowlist in auth middleware
export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
