import { GetItemCommand, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateOrgSchema } from '@filone/shared';
import type { AuditActor, ErrorResponse, UpdateOrgResponse } from '@filone/shared';
import { Resource } from 'sst';
import { AuditSubjects, auditEvent, commitAudited, userActor } from '../lib/audit.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { SanitizedOrgNameSchema } from '../lib/org-name-validation.js';
import { ORG_LOGO_KEY_PREFIX, isOwnedAssetUrl } from '../lib/org-logo-storage.js';
import { releaseOrgSlugItem, reserveOrgSlug } from '../lib/org-slug.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * The wire shape with the stored shape's sanitization folded in, so one parse
 * produces the value that gets written. Escaping belongs inside the same schema
 * rather than in a second pass over the result: `ORG_NAME_PATTERN` already
 * rejects every character `validator.escape` would touch, so a second parse of
 * the escaped name has no reachable failure branch to report.
 */
const UpdateOrgBodySchema = UpdateOrgSchema.extend({ name: SanitizedOrgNameSchema });

/**
 * PATCH /api/org — rename the organization, and optionally its logo.
 *
 * Its own route because its requirement is its own: changing either is
 * `org.rename`, held by Owner and Admin, while the profile fields it used to
 * share a body with are things any member changes about themselves. One route
 * carrying both would have to choose between locking a ReadOnly member out of
 * their own name and letting them rename the company.
 *
 * `logoUrl`, when present, must already be a URL `POST /api/org/logo-upload-url`
 * returned — this handler only ever persists the string, same as `create-org`.
 * It rides the rename's own transaction when the name changed too, or a
 * lighter transaction of its own (no slug work) when it is the only thing
 * that changed.
 *
 * Rename and logo are the only two verbs here. Ownership transfer and
 * deletion are their own permissions and their own routes when they ship.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId } = getUserInfo(event);
  // Verified only, and this route runs without the verified-email gate, so it
  // is often absent — the audit actor's id is the userId either way.
  const email = getVerifiedEmail(event);

  const parsed = parseJsonBody(event.body, UpdateOrgBodySchema);
  if ('error' in parsed) return parsed.error;
  const { name, logoUrl } = parsed.data;

  const rejected = foreignLogoUrlResponse(logoUrl);
  if (rejected) return rejected;

  const profileKey = orgProfileKey(orgId);
  const previous = await readOrgProfile(profileKey);

  const nameChanged = previous.name !== name;
  // Absent means "the avatar picker was untouched", not "clear the logo" —
  // there is no way to remove one through this endpoint yet.
  const logoChanged = logoUrl !== undefined && logoUrl !== previous.logoUrl;

  // Submitting the form unchanged is what the Settings page does on every
  // save, and there is nothing to record: an event saying an org was renamed
  // from "Acme" to "Acme" is noise in the log a customer reads.
  if (!nameChanged && !logoChanged) return unchangedOrgResponse(name, previous);

  const actor = userActor({ userId, email });

  // Logo-only save: nothing about the slug is affected, so this skips
  // `reserveOrgSlug` and the rename's transaction entirely for a lighter,
  // single-purpose write.
  if (!nameChanged) {
    return await saveLogoOnly({
      profileKey,
      orgId,
      name,
      slug: previous.slug,
      logoUrl: logoUrl as string,
      previousLogoUrl: previous.logoUrl,
      actor,
    });
  }

  // Re-slugified alongside the name: the slug is derived from it, so a rename
  // that kept the old slug would route the new name through words nobody
  // typed. Reserved before the transaction, the same read-then-plan-the-write
  // split `reserveOrgSlug` always does — this call commits nothing.
  const { slug, reservationItem } = await reserveOrgSlug({ orgId, name });

  try {
    await renameOrg({
      key: profileKey,
      orgId,
      name,
      slug,
      previousName: previous.name,
      previousSlug: previous.slug,
      logoUrl: logoChanged ? logoUrl : undefined,
      previousLogoUrl: previous.logoUrl,
      reservationItem,
      actor,
    });
  } catch (err) {
    if (renameConditionFailed(err)) return await renameConflictResponse(profileKey);
    throw err;
  }

  const responseLogoUrl = logoChanged ? logoUrl : previous.logoUrl;
  return new ResponseBuilder()
    .status(200)
    .body<UpdateOrgResponse>({
      name,
      slug,
      ...(responseLogoUrl ? { logoUrl: responseLogoUrl } : {}),
    })
    .build();
}

type OrgProfileKey = Record<'pk' | 'sk', { S: string }>;

function orgProfileKey(orgId: string): OrgProfileKey {
  return { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } };
}

/** The 400 for a `logoUrl` that did not come from our own upload endpoint, or nothing. */
function foreignLogoUrlResponse(
  logoUrl: string | undefined,
): APIGatewayProxyStructuredResultV2 | undefined {
  if (logoUrl === undefined || isOwnedAssetUrl(logoUrl, ORG_LOGO_KEY_PREFIX)) return undefined;
  return new ResponseBuilder()
    .status(400)
    .body<ErrorResponse>({ message: 'Logo must be uploaded through the logo upload endpoint.' })
    .build();
}

/** Nothing changed: the same 200 body a save always answers with, built from what's stored. */
function unchangedOrgResponse(
  name: string,
  previous: { slug?: string; logoUrl?: string },
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(200)
    .body<UpdateOrgResponse>({
      name,
      ...(previous.slug ? { slug: previous.slug } : {}),
      ...(previous.logoUrl ? { logoUrl: previous.logoUrl } : {}),
    })
    .build();
}

/**
 * The org's current name, slug, and logo, each possibly undefined when the
 * row carries none.
 *
 * A read rather than `UPDATED_OLD`, because the event needs the previous name
 * and an update returns nothing for an attribute that was absent: every org
 * created before naming shipped has no `name` on its profile row, so the event
 * would record a rename with no predecessor. Consistent, because the value is
 * what the write then conditions on. `slug` rides the same read: an org that
 * predates the slug backfill has none yet, which the rename gives it for the
 * first time rather than releasing a reservation that was never made.
 * `logoUrl` rides along too, so both a rename and a logo-only save (`!
 * nameChanged` below) can tell whether their respective field actually
 * changed without a second round trip.
 */
async function readOrgProfile(
  key: OrgProfileKey,
): Promise<{ name?: string; slug?: string; logoUrl?: string }> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      ProjectionExpression: '#name, slug, logoUrl',
      ExpressionAttributeNames: { '#name': 'name' },
      ConsistentRead: true,
    }),
  );
  return { name: Item?.name?.S, slug: Item?.slug?.S, logoUrl: Item?.logoUrl?.S };
}

/**
 * Whether the rename's own condition is what cancelled the transaction.
 *
 * Only `ConditionalCheckFailed` on the update item, which is the first item in
 * the transaction, means the row moved under this request. A
 * `TransactionConflict` or a throttle cancels the same item and means the
 * opposite: the write did not happen and a retry may still land, so reporting
 * it as "someone else renamed it" states something untrue and hides a
 * retryable failure from the caller. The audit item's own failures never reach
 * here — `commitAudited` raises `AuditAppendError` for those.
 */
function renameConditionFailed(err: unknown): boolean {
  return (
    err instanceof TransactionCanceledException &&
    err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
  );
}

/**
 * Which of the two things the failed condition means.
 *
 * The condition covers both the row existing and its name still being the one
 * the event is about, so a cancellation is either an org deleted between the
 * session and this request or a rename that landed while this one was in
 * flight. One read tells them apart, and it only runs on this path.
 *
 * Consistent, for the same reason the read above is: a replica that has not
 * caught up with a row the leader confirmed milliseconds ago would answer a
 * conflict with "your organization does not exist".
 */
async function renameConflictResponse(
  key: OrgProfileKey,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      ConsistentRead: true,
    }),
  );

  if (!Item) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Organization not found' })
      .build();
  }

  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({ message: 'The organization was renamed by someone else — try again' })
    .build();
}

/**
 * Write the new name and slug (and, when it changed too, the logo) and the
 * event that records it, in one transaction.
 *
 * The name write is conditional on the name the event names, not merely on the
 * row existing, so the transition the log records is the transition that
 * happened. Without it two concurrent renames both report their own
 * predecessor and the log claims a change that never took place.
 *
 * The slug's own uniqueness is enforced by {@link reservationItem}'s own
 * condition, not by anything here — a collision there cancels the whole
 * transaction the same way a stale name does, and the caller retries with a
 * fresh `reserveOrgSlug` call. The old slug is released in the same
 * transaction (skipped when the org had none yet), so a stale slug is never
 * left claiming a route nothing answers to; the frontend's rule that any
 * non-active slug falls back to the active org's own means no redirect target
 * needs recording for it.
 *
 * The pair being a transaction is the point: a rename that reached the profile
 * row without reaching the log would be a change to the org nobody can see.
 */
async function renameOrg({
  key,
  orgId,
  name,
  slug,
  previousName,
  previousSlug,
  logoUrl,
  previousLogoUrl,
  reservationItem,
  actor,
}: {
  key: OrgProfileKey;
  orgId: string;
  name: string;
  slug: string;
  previousName?: string;
  previousSlug?: string;
  /** Only when this same save also changed the logo — undefined leaves it untouched. */
  logoUrl?: string;
  previousLogoUrl?: string;
  reservationItem: TransactWriteItem;
  actor: AuditActor;
}): Promise<void> {
  await commitAudited({
    items: [
      {
        Update: {
          TableName: Resource.UserInfoTable.name,
          Key: key,
          // Naming it is what confirms it, so the flag rides the same write
          // rather than needing a request field of its own. `logoUrl` only
          // joins the SET clause when this save changed it too.
          UpdateExpression: [
            'SET #name = :name, slug = :slug, nameConfirmed = :confirmed',
            logoUrl !== undefined ? ', logoUrl = :logoUrl' : '',
          ].join(''),
          // An org created before naming shipped has no name to match, so the
          // two cases condition on absence and on the value respectively.
          ConditionExpression:
            previousName === undefined
              ? 'attribute_exists(pk) AND attribute_not_exists(#name)'
              : 'attribute_exists(pk) AND #name = :previousName',
          ExpressionAttributeNames: { '#name': 'name' },
          ExpressionAttributeValues: {
            ':name': { S: name },
            ':slug': { S: slug },
            ':confirmed': { BOOL: true },
            ...(previousName === undefined ? {} : { ':previousName': { S: previousName } }),
            ...(logoUrl !== undefined ? { ':logoUrl': { S: logoUrl } } : {}),
          },
        },
      },
      ...(previousSlug ? [releaseOrgSlugItem(previousSlug)] : []),
      reservationItem,
    ],
    event: auditEvent({
      type: 'org.renamed',
      actor,
      orgId,
      subject: AuditSubjects.org(orgId),
      details: {
        name,
        ...(previousName ? { previousName } : {}),
        ...(logoUrl !== undefined
          ? { logoUrl, ...(previousLogoUrl ? { previousLogoUrl } : {}) }
          : {}),
      },
    }),
  });
}

/**
 * Write a logo-only change and the event that records it, in one transaction.
 *
 * No slug work: the name is unchanged, so nothing derived from it needs
 * touching. The condition still only asks that the row exist — unlike
 * {@link renameOrg}, there is no previous value to race against here, since
 * this path only runs once `readOrgProfile` has already confirmed `logoUrl`
 * actually differs from what is stored.
 */
async function updateOrgLogo({
  key,
  orgId,
  logoUrl,
  previousLogoUrl,
  actor,
}: {
  key: OrgProfileKey;
  orgId: string;
  logoUrl: string;
  previousLogoUrl?: string;
  actor: AuditActor;
}): Promise<void> {
  await commitAudited({
    items: [
      {
        Update: {
          TableName: Resource.UserInfoTable.name,
          Key: key,
          UpdateExpression: 'SET logoUrl = :logoUrl',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':logoUrl': { S: logoUrl } },
        },
      },
    ],
    event: auditEvent({
      type: 'org.logo_updated',
      actor,
      orgId,
      subject: AuditSubjects.org(orgId),
      details: { logoUrl, ...(previousLogoUrl ? { previousLogoUrl } : {}) },
    }),
  });
}

/**
 * The logo-only branch of `baseHandler`, pulled out so its own try/catch does
 * not add to the main function's complexity budget.
 */
async function saveLogoOnly({
  profileKey,
  orgId,
  name,
  slug,
  logoUrl,
  previousLogoUrl,
  actor,
}: {
  profileKey: OrgProfileKey;
  orgId: string;
  name: string;
  slug?: string;
  logoUrl: string;
  previousLogoUrl?: string;
  actor: AuditActor;
}): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    await updateOrgLogo({ key: profileKey, orgId, logoUrl, previousLogoUrl, actor });
  } catch (err) {
    if (renameConditionFailed(err)) return await renameConflictResponse(profileKey);
    throw err;
  }
  return new ResponseBuilder()
    .status(200)
    .body<UpdateOrgResponse>({ name, ...(slug ? { slug } : {}), logoUrl })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  // Opt out of the verified-email gate, as `update-profile` does: the Settings
  // page carries both forms, and a user who mistyped their address on signup
  // has to be able to use it. Renaming the org changes nothing about the
  // caller's identity, so nothing here can be used to bypass verification.
  .use(authMiddleware({ requireVerifiedEmail: false }))
  .use(authorize('org.rename'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
