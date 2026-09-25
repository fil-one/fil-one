import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UpdateProfileResponse, ErrorResponse } from '@filone/shared';
import { UpdateProfileSchema, isSocialConnection, ApiErrorCode } from '@filone/shared';
import disposableDomainsList from 'disposable-domains';
import * as psl from 'psl';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.ts';
import { ResponseBuilder } from '../lib/response-builder.ts';
import {
  updateAuth0User,
  sendVerificationEmail,
  getConnectionType,
  getAuth0UserPicture,
} from '../lib/auth0-management.ts';
import {
  withClaimedAvatar,
  deleteReplacedAvatar,
  isUploadedAvatarUrl,
} from '../lib/avatar-storage.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, requestTokenRefresh } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

const DISPOSABLE_DOMAINS = new Set(disposableDomainsList as string[]);

function isDisposableDomain(domain: string): boolean {
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  // The blocklist holds registrable domains, so an exact match misses
  // subdomain addresses (e.g. user@foo.mailinator.com). Check the
  // registrable domain (eTLD+1) as well.
  const registrable = psl.get(domain);
  return registrable !== null && registrable !== domain && DISPOSABLE_DOMAINS.has(registrable);
}

/**
 * PATCH /api/me/profile — the caller's own name, email, and avatar, and
 * nothing else.
 *
 * A `self` route in the manifest: an authenticated session is the whole
 * requirement. No role gates it, and neither does membership — a user whose
 * membership row is missing is exactly the user who needs to reach Settings,
 * and their name and email are theirs whatever any org says. Renaming the
 * organization moved to `PATCH /api/org`, which is `org.rename`.
 */
async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub } = getUserInfo(event);
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

  // Checked before anything is written, so a rejected avatar never lands a
  // name or email change alongside the 400.
  const pictureError =
    rejectSocialPicture(social, parsed.data.pictureUrl) ??
    (await rejectUnmintedPicture(parsed.data.pictureUrl));
  if (pictureError) return pictureError;

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

  if (parsed.data.pictureUrl !== undefined) {
    await applyPictureUpdate(sub, parsed.data.pictureUrl);
    response.picture = parsed.data.pictureUrl;
  }

  if (
    response.name !== undefined ||
    response.email !== undefined ||
    response.picture !== undefined
  ) {
    requestTokenRefresh(event);
  }

  return new ResponseBuilder().status(200).body(response).build();
}

/**
 * The 400 for a `pictureUrl` no avatar upload minted, or undefined when there
 * is none to check or it passes. `PATCH /api/me/profile` writes the URL to the
 * caller's Auth0 profile, so an arbitrary one would have every console that
 * renders their avatar request a host of the caller's choosing.
 */
async function rejectUnmintedPicture(
  pictureUrl: string | undefined,
): Promise<APIGatewayProxyResultV2 | undefined> {
  if (pictureUrl === undefined || (await isUploadedAvatarUrl(pictureUrl))) return undefined;
  return new ResponseBuilder()
    .status(400)
    .body<ErrorResponse>({
      message: 'pictureUrl must be a URL returned by the avatar upload endpoint',
    })
    .build();
}

/**
 * Point the profile at the new avatar, claimed first so the lifecycle rule
 * cannot delete a picture the profile already names (a failed save puts the
 * claim back). Then the one it replaced, if it was ours, is deleted.
 */
async function applyPictureUpdate(sub: string, pictureUrl: string): Promise<void> {
  const previous = await getAuth0UserPicture(sub);
  await withClaimedAvatar(pictureUrl, () => updateAuth0User(sub, { picture: pictureUrl }));
  if (previous !== pictureUrl) await deleteReplacedAvatar(previous);
}

/**
 * The 400 for a picture change on a social login account, like its name and
 * email. The provider owns the picture too: Auth0 re-syncs it from the
 * provider on login, so an uploaded avatar would be replaced and its file left
 * in the bucket.
 */
function rejectSocialPicture(
  social: boolean,
  pictureUrl: string | undefined,
): APIGatewayProxyResultV2 | undefined {
  if (!social || pictureUrl === undefined) return undefined;
  return new ResponseBuilder()
    .status(400)
    .body<ErrorResponse>({
      message: 'Avatar cannot be changed for social login accounts. Update it at your provider.',
    })
    .build();
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

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  // Opt out of the verified-email gate: users must be able to correct a
  // mistyped email address while unverified. Email changes always reset
  // email_verified to false and re-trigger verification, so this cannot be
  // used to bypass the gate.
  .use(authMiddleware({ requireVerifiedEmail: false }))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
