import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';

/**
 * The organizations beta flag, which gates one thing: creating an invitation.
 *
 * Data-driven, so granting it is a row rather than a redeploy — the mechanism
 * `middleware/rag-access.ts` explicitly invites reusing, with `ORGS_BETA` as the
 * sort key beside that file's `RAG`. Two rows can grant it:
 *
 * - `ALLOWLIST#{lowercased-email}` / `ORGS_BETA` — one person, the shape the RAG
 *   flag already uses.
 * - `ORG#{orgId}` / `ORGS_BETA` — a whole organization at once, which is the
 *   entity an enterprise beta actually wants: FilOne learns an employee's email
 *   only at their first login, so enumerating them up front is not possible.
 *
 * Presence is the grant; attribute values are never read.
 *
 * Everything downstream of an invitation existing is unflagged. Accepting checks
 * nothing here — an invitee's experience must not depend on their allowlist
 * status — and the members surfaces render from org state. A non-allowlisted
 * Admin in a real multi-member org therefore sees the members page without the
 * invite button.
 */

/** The sort key both rows share, so the two lookups cannot disagree on the flag. */
const ORGS_BETA_SK = 'ORGS_BETA';

/**
 * Whether the caller may create invitations: their own allowlist row, or their
 * org's.
 *
 * Both reads are issued together because either grants, and the common answer for
 * a flagged beta is that one of them exists — waiting on the first to decide
 * whether to make the second would put a round trip on the path for nobody's
 * benefit. Consistent reads, because granting the flag is a manual operation
 * somebody performs and then immediately tries.
 *
 * An unverified or absent email contributes nothing: the address a session claims
 * without verifying it is not an identity we grant anything on, exactly as the
 * RAG gate treats it. The org row still applies, so an enterprise beta does not
 * depend on every member having verified an address.
 */
export async function hasOrgsBetaAccess({
  verifiedEmail,
  orgId,
}: {
  verifiedEmail?: string;
  orgId: string;
}): Promise<boolean> {
  const [byEmail, byOrg] = await Promise.all([
    verifiedEmail ? rowExists(`ALLOWLIST#${verifiedEmail.toLowerCase()}`) : Promise.resolve(false),
    rowExists(`ORG#${orgId}`),
  ]);
  return byEmail || byOrg;
}

async function rowExists(pk: string): Promise<boolean> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: pk }, sk: { S: ORGS_BETA_SK } },
      ConsistentRead: true,
    }),
  );
  return Item !== undefined;
}
