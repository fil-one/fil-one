import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UpdateProfileResponse, ErrorResponse } from '@filone/shared';
import { UpdateProfileSchema, isSocialConnection, ApiErrorCode } from '@filone/shared';
import disposableDomainsList from 'disposable-email-domains';
import * as psl from 'psl';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { SanitizedOrgNameSchema } from '../lib/org-name-validation.js';
import {
  updateAuth0User,
  sendVerificationEmail,
  getConnectionType,
} from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, requestTokenRefresh } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

const DISPOSABLE_DOMAINS = new Set(disposableDomainsList as string[]);

function isDisposableDomain(domain: string): boolean {
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  // The blocklist holds registrable domains, so an exact match misses
  // subdomain addresses (e.g. user@foo.mailinator.com). Check the
  // registrable domain (eTLD+1) as well.
  const registrable = psl.get(domain);
  return registrable !== null && registrable !== domain && DISPOSABLE_DOMAINS.has(registrable);
}

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, sub } = getUserInfo(event);
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Invalid JSON body' })
      .build();
  }

  const parsed = UpdateProfileSchema.safeParse(body);
  if (!parsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: parsed.error.issues[0].message })
      .build();
  }

  const connectionType = getConnectionType(sub);
  const social = isSocialConnection(connectionType);
  const response: UpdateProfileResponse = {};

  if (parsed.data.name !== undefined) {
    const error = await applyNameUpdate(sub, social, parsed.data.name);
    if (error) return error;
    response.name = parsed.data.name;
  }

  if (parsed.data.email !== undefined) {
    const error = await applyEmailUpdate(sub, social, parsed.data.email);
    if (error) return error;
    response.email = parsed.data.email;
  }

  if (parsed.data.orgName !== undefined) {
    const result = await applyOrgNameUpdate(orgId, parsed.data.orgName);
    if ('error' in result) return result.error;
    response.orgName = result.sanitized;
  }

  if (response.name !== undefined || response.email !== undefined) {
    requestTokenRefresh(event);
  }

  return new ResponseBuilder().status(200).body(response).build();
}

async function applyNameUpdate(
  sub: string,
  social: boolean,
  name: string,
): Promise<APIGatewayProxyResultV2 | undefined> {
  if (social) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({
        message: 'Name cannot be changed for social login accounts. Update it at your provider.',
      })
      .build();
  }
  await updateAuth0User(sub, { name });
  return undefined;
}

async function applyEmailUpdate(
  sub: string,
  social: boolean,
  email: string,
): Promise<APIGatewayProxyResultV2 | undefined> {
  if (social) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({
        message: 'Email cannot be changed for social login accounts. Update it at your provider.',
      })
      .build();
  }

  const domain = email.split('@')[1]?.toLowerCase();
  if (domain && isDisposableDomain(domain)) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({
        message: 'Disposable email addresses are not allowed.',
        code: ApiErrorCode.DISPOSABLE_EMAIL_BLOCKED,
      })
      .build();
  }

  // The new email is unverified (email_verified is reset below), so clear the
  // claim flag — the normalized form is (re)claimed on the next verified login.
  // The previous email's entitlement record is append-only and never released.
  await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `SUB#${sub}` }, sk: { S: 'IDENTITY' } },
      UpdateExpression: 'REMOVE emailEntitlementClaimed',
    }),
  );

  await updateAuth0User(sub, { email, email_verified: false });
  // TODO: sync updated email to Stripe customer profile when we store a separate billing email
  // https://linear.app/filecoin-foundation/issue/FIL-141/sync-stripe-customer-email-after-auth0-email-verification-via-auth0
  try {
    await sendVerificationEmail(sub);
  } catch (err) {
    // Email was updated in Auth0 but verification send failed.
    // Log and continue — the user can resend from the UI.
    console.error('[update-profile] Failed to send verification email after email update', {
      error: err,
    });
  }
  return undefined;
}

async function applyOrgNameUpdate(
  orgId: string,
  orgName: string,
): Promise<{ error: APIGatewayProxyResultV2 } | { sanitized: string }> {
  const sanitizeResult = SanitizedOrgNameSchema.safeParse(orgName);
  if (!sanitizeResult.success) {
    return {
      error: new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({ message: sanitizeResult.error.issues[0].message })
        .build(),
    };
  }
  const sanitized = sanitizeResult.data;

  await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
      UpdateExpression: 'SET #name = :name',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: {
        ':name': { S: sanitized },
      },
    }),
  );
  return { sanitized };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  // Opt out of the verified-email gate: users must be able to correct a
  // mistyped email address while unverified. Email changes always reset
  // email_verified to false and re-trigger verification, so this cannot be
  // used to bypass the gate.
  .use(authMiddleware({ requireVerifiedEmail: false }))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
