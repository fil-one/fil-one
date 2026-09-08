import { GetItemCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';

/**
 * Org slugs: the URL-safe identifier every org-scoped route is keyed by
 * (`/<slug>/dashboard`), unique across the whole platform rather than per
 * account — two different accounts' orgs cannot claim the same slug.
 *
 * Slugs are random and opaque, not derived from the org name: an org's name
 * carries no uniqueness requirement of its own, so two orgs (even two owned by
 * different accounts) may share a display name without anything downstream
 * having to disambiguate them. A slug is reserved once, at creation, and never
 * reassigned — renaming an org changes what it is called, never the URL it
 * lives at.
 *
 * The reservation row lives in OrgTable (which has no GSI, per
 * `org-membership.ts`), using the same claim-row idiom as
 * `INVITETOKEN#{hash}/LOOKUP`: `pk: SLUG#{slug}`, `sk: LOOKUP` → `{ orgId }`.
 * Uniqueness is enforced by that row's own `attribute_not_exists(pk)`
 * condition wherever it is written, the same pattern as the identity row in
 * `account-creation.ts` — this module never writes it itself, only plans the
 * write, so it composes into whatever transaction is creating the org.
 */

const SlugKeys = {
  pk: (slug: string): string => `SLUG#${slug}`,
  sk: (): string => 'LOOKUP',
} as const;

/** Bounded probing before falling back to a fresh full UUID — never loops forever. */
const MAX_SLUG_ATTEMPTS = 5;

export interface ReservedOrgSlug {
  /** The slug this org may claim — not yet claimed, only found available. */
  slug: string;
  /**
   * The transaction item that claims it. Not sent here: the caller folds this
   * into its own `TransactWriteItems`, so the reservation lands atomically
   * with the row it names (the new org's profile).
   */
  reservationItem: TransactWriteItem;
}

function reservationItem(slug: string, orgId: string, tableName: string): TransactWriteItem {
  return {
    Put: {
      TableName: tableName,
      Item: {
        pk: { S: SlugKeys.pk(slug) },
        sk: { S: SlugKeys.sk() },
        orgId: { S: orgId },
      },
      // The real guard against two orgs claiming the same slug: the probe
      // below only narrows the search, it is not what makes the slug unique.
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

async function slugTaken(slug: string, tableName: string): Promise<boolean> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: SlugKeys.pk(slug) }, sk: { S: SlugKeys.sk() } },
    }),
  );
  return Item !== undefined;
}

/** A short, URL-safe, random candidate — no relationship to anything about the org. */
function randomSlugCandidate(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

/**
 * Reserve a fresh, random slug for `orgId`.
 *
 * A read-then-plan-the-write split, not a series of conditioned writes: this
 * function commits nothing, so it never leaves a claimed-but-unused row behind
 * when the caller's own transaction — the one this reservation is really
 * for — goes on to fail for an unrelated reason. The probe's reads are a
 * courtesy that keeps the common case to one round trip before the write;
 * the write's own `attribute_not_exists(pk)` condition is what actually
 * decides uniqueness, in whatever transaction the caller commits this into.
 *
 * Collisions between two random 10-character candidates are vanishingly
 * unlikely, so {@link MAX_SLUG_ATTEMPTS} exists only to bound the loop, not
 * because collisions are expected — the fallback after exhausting it is a
 * full UUID rather than another short candidate.
 */
export async function reserveOrgSlug({
  orgId,
  tableName = Resource.OrgTable.name,
}: {
  orgId: string;
  tableName?: string;
}): Promise<ReservedOrgSlug> {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const candidate = randomSlugCandidate();
    if (!(await slugTaken(candidate, tableName))) {
      return { slug: candidate, reservationItem: reservationItem(candidate, orgId, tableName) };
    }
  }

  const fallback = crypto.randomUUID();
  return { slug: fallback, reservationItem: reservationItem(fallback, orgId, tableName) };
}
