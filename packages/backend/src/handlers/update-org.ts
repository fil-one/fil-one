import {
  GetItemCommand,
  TransactionCanceledException,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateOrgSchema } from '@filone/shared';
import type { AuditActor, ErrorResponse, UpdateOrgResponse } from '@filone/shared';
import { Resource } from 'sst';
import { AuditSubjects, auditEvent, commitAudited, userActor } from '../lib/audit.ts';
import { getDynamoClient } from '../lib/ddb-client.ts';
import {
  deleteReplacedOrgLogo,
  withClaimedOrgLogo,
  isUploadedOrgLogoUrl,
} from '../lib/org-logo-storage.ts';
import { parseJsonBody } from '../lib/parse-json-body.ts';
import { ResponseBuilder } from '../lib/response-builder.ts';
import { proceed, refuse } from '../lib/result.ts';
import type { Result } from '../lib/result.ts';
import { SanitizedOrgNameSchema } from '../lib/org-name-validation.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

/**
 * The wire shape with the stored shape's sanitization folded in, so one parse
 * produces the value that gets written. Escaping belongs inside the same schema
 * rather than in a second pass over the result: `ORG_NAME_PATTERN` already
 * rejects every character `validator.escape` would touch, so a second parse of
 * the escaped name has no reachable failure branch to report.
 */
const UpdateOrgBodySchema = UpdateOrgSchema.extend({
  name: SanitizedOrgNameSchema.optional(),
}).refine((body) => body.name !== undefined || body.logoUrl !== undefined, {
  message: 'Send a name, a logoUrl, or both',
});

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
 * returned, checked the same way `create-org` checks it.
 * It rides the same transaction as the rename.
 *
 * Either field may come alone. A body without `name` leaves the name as
 * stored: the console's logo save sends none, because a name read when the
 * file was picked could revert a rename that landed during the upload.
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
  const { logoUrl } = parsed.data;

  const profileKey = orgProfileKey(orgId);
  const previous = await readOrgProfile(profileKey);

  const { name, nameChanged, confirmUnchanged } = resolveNameChange(parsed.data.name, previous);
  const logo = await resolveLogoChange(logoUrl, previous.logoUrl);
  if (!logo.ok) return logo.refusal;
  const logoChanged = logo.value;

  if (confirmUnchanged) await confirmName(profileKey);

  // Submitting the form unchanged is what the Settings page does on every
  // save, and there is nothing to record: an event saying an org was renamed
  // from "Acme" to "Acme" is noise in the log a customer reads.
  if (!nameChanged && !logoChanged) return orgResponse(name, previous.logoUrl);

  try {
    await saveOrg({
      key: profileKey,
      orgId,
      name: nameChanged ? name : undefined,
      previousName: previous.name,
      logoUrl: logoChanged ? logoUrl : undefined,
      previousLogoUrl: previous.logoUrl,
      actor: userActor({ userId, email }),
    });
  } catch (err) {
    if (renameConditionFailed(err)) {
      return await renameConflictResponse(profileKey, nameChanged);
    }
    throw err;
  }

  return orgResponse(name, logoChanged ? logoUrl : previous.logoUrl);
}

function orgResponse(name: string, logoUrl: string | undefined): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(200)
    .body<UpdateOrgResponse>({ name, ...(logoUrl ? { logoUrl } : {}) })
    .build();
}

/**
 * What the org is called once this request is done, whether that is a rename,
 * and whether an unchanged name still needs confirming.
 *
 * No name sent means a logo-only save: the stored name stands, and it confirms
 * nothing. A new account that accepts its prefilled suggested name unchanged
 * still has to confirm it: the name already matches, so no rename will ever
 * flip `nameConfirmed`, and skipping it strands that account re-redirected to
 * `/create-organization` on every load.
 */
function resolveNameChange(
  sent: string | undefined,
  previous: { name?: string; nameConfirmed: boolean },
): { name: string; nameChanged: boolean; confirmUnchanged: boolean } {
  if (sent === undefined) {
    return { name: previous.name ?? '', nameChanged: false, confirmUnchanged: false };
  }
  const nameChanged = previous.name !== sent;
  return { name: sent, nameChanged, confirmUnchanged: !nameChanged && !previous.nameConfirmed };
}

/**
 * Whether the submitted logo differs from the stored one, or the 400 that
 * refuses it.
 *
 * Absent means "the avatar picker was untouched", not "clear the logo":
 * there is no way to remove one through this endpoint yet. A changed logo gets
 * the same trust `create-org` gives one: only an unclaimed upload the presign
 * step minted. An unchanged logo is the one already stored, so it needs no
 * second look.
 */
async function resolveLogoChange(
  logoUrl: string | undefined,
  previousLogoUrl: string | undefined,
): Promise<Result<boolean>> {
  if (logoUrl === undefined || logoUrl === previousLogoUrl) return proceed(false);
  if (await isUploadedOrgLogoUrl(logoUrl)) return proceed(true);
  return refuse(
    new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({
        message: 'logoUrl must be a URL returned by the logo upload endpoint',
      })
      .build(),
  );
}

/**
 * The row exists, and each field this save writes is still the value this
 * request read. An org created before naming shipped has no name to match, so
 * each field conditions on absence or on the value.
 */
function saveCondition({
  renamed,
  previousName,
  logoChanged,
  previousLogoUrl,
}: {
  renamed: boolean;
  previousName?: string;
  logoChanged: boolean;
  previousLogoUrl?: string;
}): string {
  return [
    'attribute_exists(pk)',
    ...(renamed
      ? [previousName === undefined ? 'attribute_not_exists(#name)' : '#name = :previousName']
      : []),
    ...(logoChanged
      ? [
          previousLogoUrl === undefined
            ? 'attribute_not_exists(logoUrl)'
            : 'logoUrl = :previousLogoUrl',
        ]
      : []),
  ].join(' AND ');
}

type OrgProfileKey = Record<'pk' | 'sk', { S: string }>;

function orgProfileKey(orgId: string): OrgProfileKey {
  return { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } };
}

/**
 * The org's current name and logo, each possibly undefined when the row
 * carries none, and whether that name has been confirmed.
 *
 * A read rather than `UPDATED_OLD`, because the event needs the previous name
 * and an update returns nothing for an attribute that was absent: every org
 * created before naming shipped has no `name` on its profile row, so the event
 * would record a rename with no predecessor. Consistent, because the value is
 * what the write then conditions on. `logoUrl` rides along, so the save can
 * tell whether the logo changed without a second round trip.
 */
async function readOrgProfile(
  key: OrgProfileKey,
): Promise<{ name?: string; nameConfirmed: boolean; logoUrl?: string }> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      ProjectionExpression: '#name, nameConfirmed, logoUrl',
      ExpressionAttributeNames: { '#name': 'name' },
      ConsistentRead: true,
    }),
  );
  return {
    name: Item?.name?.S,
    nameConfirmed: Item?.nameConfirmed?.BOOL ?? false,
    logoUrl: Item?.logoUrl?.S,
  };
}

/**
 * Flip `nameConfirmed` on its own, for the submit-unchanged path: the name is
 * already correct, so nothing else about the profile row needs to move, and
 * there is no rename to audit — the org's name never changed.
 */
async function confirmName(key: OrgProfileKey): Promise<void> {
  await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      UpdateExpression: 'SET nameConfirmed = :confirmed',
      ExpressionAttributeValues: { ':confirmed': { BOOL: true } },
    }),
  );
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
 * The condition covers both the row existing and the fields still being the
 * ones the event is about, so a cancellation is either an org deleted between
 * the session and this request or a save that landed while this one was in
 * flight. One read tells them apart, and it only runs on this path.
 *
 * Consistent, for the same reason the read above is: a replica that has not
 * caught up with a row the leader confirmed milliseconds ago would answer a
 * conflict with "your organization does not exist".
 */
async function renameConflictResponse(
  key: OrgProfileKey,
  renamed: boolean,
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

  const message = renamed
    ? 'The organization was renamed by someone else — try again'
    : 'The logo was changed by someone else. Try again.';
  return new ResponseBuilder().status(409).body<ErrorResponse>({ message }).build();
}

/**
 * Write the new name, the new logo, or both, and the event that records it, in
 * one transaction.
 *
 * The write is conditional on the name and logo this request read, so the
 * transition the log records is the transition that happened. Without it two
 * concurrent saves both report their own predecessor, and two logo saves both
 * land, leaving the first new logo claimed, pointed at by nothing, and never
 * deleted.
 *
 * The pair being a transaction is the point: a change that reached the profile
 * row without reaching the log would be a change to the org nobody can see.
 */
async function saveOrg({
  key,
  orgId,
  name,
  previousName,
  logoUrl,
  previousLogoUrl,
  actor,
}: {
  key: OrgProfileKey;
  orgId: string;
  /** Only when this save renames the org; undefined leaves the name untouched. */
  name?: string;
  previousName?: string;
  /** Only when this save changes the logo; undefined leaves it untouched. */
  logoUrl?: string;
  previousLogoUrl?: string;
  actor: AuditActor;
}): Promise<void> {
  const renamed = name !== undefined;
  const logoChanged = logoUrl !== undefined;
  const logoDetails = logoChanged
    ? { logoUrl, ...(previousLogoUrl ? { previousLogoUrl } : {}) }
    : {};
  const commit = () =>
    commitAudited({
      items: [
        {
          Update: {
            TableName: Resource.UserInfoTable.name,
            Key: key,
            // Naming it is what confirms it, so the flag rides the same write.
            UpdateExpression: `SET ${[
              ...(renamed ? ['#name = :name', 'nameConfirmed = :confirmed'] : []),
              ...(logoChanged ? ['logoUrl = :logoUrl'] : []),
            ].join(', ')}`,
            ConditionExpression: saveCondition({
              renamed,
              previousName,
              logoChanged,
              previousLogoUrl,
            }),
            ...(renamed ? { ExpressionAttributeNames: { '#name': 'name' } } : {}),
            ExpressionAttributeValues: {
              ...(renamed ? { ':name': { S: name }, ':confirmed': { BOOL: true } } : {}),
              ...(renamed && previousName !== undefined
                ? { ':previousName': { S: previousName } }
                : {}),
              ...(logoChanged ? { ':logoUrl': { S: logoUrl } } : {}),
              ...(logoChanged && previousLogoUrl !== undefined
                ? { ':previousLogoUrl': { S: previousLogoUrl } }
                : {}),
            },
          },
        },
      ],
      event: auditEvent({
        actor,
        orgId,
        subject: AuditSubjects.org(orgId),
        ...(renamed
          ? {
              type: 'org.renamed',
              details: { name, ...(previousName ? { previousName } : {}), ...logoDetails },
            }
          : { type: 'org.logo_updated', details: { logoUrl: logoUrl!, ...logoDetails } }),
      }),
    });
  if (!logoChanged) {
    await commit();
    return;
  }
  await withClaimedOrgLogo(logoUrl, commit);
  await deleteReplacedOrgLogo(previousLogoUrl);
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
