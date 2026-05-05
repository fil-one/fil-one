import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { MeResponse } from '@filone/shared';
import { Resource } from 'sst';
import { createBillingTrial } from '../lib/create-billing-trial.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { triggerTenantSetup } from '../lib/trigger-tenant-setup.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { deriveOrgName } from '../lib/suggest-org-name.js';
import { getConnectionType } from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

interface FinalizeArgs {
  userId: string;
  orgId: string;
  email?: string;
  jwtName?: string;
  currentOrgName: string;
  currentSetupStatus: string | undefined;
}

interface FinalizeResult {
  orgName: string;
  setupStatus: string | undefined;
}

/**
 * Self-heal a legacy org row that was created before auto-confirmation. Sets the
 * derived name + orgConfirmed=true, then kicks off tenant setup and billing trial.
 * All downstream helpers are idempotent so retries are safe.
 */
async function finalizeLegacyOrg(args: FinalizeArgs): Promise<FinalizeResult> {
  const { userId, orgId, email, jwtName, currentOrgName, currentSetupStatus } = args;
  const finalName = currentOrgName || deriveOrgName(jwtName, email);
  let orgName = finalName;
  let setupStatus = currentSetupStatus;

  try {
    const { Attributes } = await getDynamoClient().send(
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
          ':name': { S: finalName },
          ':confirmed': { BOOL: true },
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    orgName = Attributes?.name?.S ?? finalName;
    setupStatus = Attributes?.setupStatus?.S ?? setupStatus;
  } catch (error) {
    console.error('[get-me] Legacy self-heal: failed to update org row', { error, orgId, userId });
  }

  try {
    await triggerTenantSetup({ orgId, orgName });
  } catch (error) {
    console.error('[get-me] Legacy self-heal: failed to trigger tenant setup', {
      error,
      orgId,
      userId,
    });
  }

  try {
    await createBillingTrial({ userId, orgId, email });
  } catch (error) {
    console.error('[get-me] Legacy self-heal: failed to create billing trial', {
      error,
      orgId,
      userId,
    });
  }

  return { orgName, setupStatus };
}

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { userId, orgId, email, emailVerified, sub, name, picture } = getUserInfo(event);

  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
    }),
  );

  const orgConfirmed = Item?.orgConfirmed?.BOOL === true;
  let setupStatus = Item?.setupStatus?.S;
  let orgName = Item?.name?.S ?? '';

  if (Item && !orgConfirmed) {
    const result = await finalizeLegacyOrg({
      userId,
      orgId,
      email,
      jwtName: name,
      currentOrgName: orgName,
      currentSetupStatus: setupStatus,
    });
    orgName = result.orgName;
    setupStatus = result.setupStatus;
  } else if (!isOrgSetupComplete(setupStatus)) {
    try {
      await triggerTenantSetup({ orgId, orgName });
    } catch (error) {
      console.error('[get-me] Failed to trigger tenant setup', { error, orgId, userId });
    }
  }

  const body: MeResponse = {
    orgId,
    orgName,
    emailVerified,
    email,
    orgSetupComplete: isOrgSetupComplete(setupStatus),
    name,
    picture,
    connectionType: getConnectionType(sub),
  };

  return new ResponseBuilder().status(200).body(body).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
