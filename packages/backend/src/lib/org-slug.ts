import { GetItemCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';

/**
 * Org slugs: the URL-safe identifier every org-scoped route is keyed by
 * (`/<slug>/dashboard`), unique across the whole platform rather than per
 * account — two different accounts' orgs cannot claim the same slug.
 *
 * The reservation row lives in OrgTable (which has no GSI, per
 * `org-membership.ts`), using the same claim-row idiom as
 * `INVITETOKEN#{hash}/LOOKUP`: `pk: SLUG#{slug}`, `sk: LOOKUP` → `{ orgId }`.
 * Uniqueness is enforced by that row's own `attribute_not_exists(pk)`
 * condition wherever it is written, the same pattern as the identity row in
 * `account-creation.ts` — this module never writes it itself, only plans the
 * write, so it composes into whatever transaction is creating or renaming the
 * org.
 */

const SlugKeys = {
  pk: (slug: string): string => `SLUG#${slug}`,
  sk: (): string => 'LOOKUP',
} as const;

/**
 * Lowercase, ASCII-fold, non-alphanumerics collapsed to a single dash, leading
 * and trailing dashes trimmed. `normalize('NFKD')` splits an accented
 * character into its base letter plus a combining mark, so stripping
 * combining marks afterward is what turns "Café" into "cafe" rather than
 * dropping the é outright.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Bounded probing before falling back to a random suffix — never loops forever. */
const MAX_SLUG_ATTEMPTS = 20;

export interface ReservedOrgSlug {
  /** The slug this org may claim — not yet claimed, only found available. */
  slug: string;
  /**
   * The transaction item that claims it. Not sent here: the caller folds this
   * into its own `TransactWriteItems`, so the reservation lands atomically
   * with the row it names (the new org's profile, or the renamed one's).
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

/** The transaction item that releases a slug an org no longer holds — a rename's old one. */
export function releaseOrgSlugItem(
  slug: string,
  tableName: string = Resource.OrgTable.name,
): TransactWriteItem {
  return {
    Delete: {
      TableName: tableName,
      Key: { pk: { S: SlugKeys.pk(slug) }, sk: { S: SlugKeys.sk() } },
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

/**
 * Find a slug for `orgId`, derived from `name`: the base slug first, then
 * `slug-2`, `slug-3`, … up to {@link MAX_SLUG_ATTEMPTS}, then a random suffix
 * that skips the search entirely (collision odds low enough not to matter, and
 * this is the fallback for a name so generic it exhausted twenty numbered
 * variants).
 *
 * A read-then-plan-the-write split, not a series of conditioned writes: this
 * function commits nothing, so it never leaves a claimed-but-unused row behind
 * when the caller's own transaction — the one this reservation is really
 * for — goes on to fail for an unrelated reason. The probe's reads are a
 * courtesy that keeps the common case to one round trip before the write;
 * the write's own `attribute_not_exists(pk)` condition is what actually
 * decides uniqueness, in whatever transaction the caller commits this into.
 *
 * A name with no alphanumeric characters at all slugifies to '', so the base
 * falls back to `'org'` rather than reserving an empty slug nothing could
 * route to.
 */
export async function reserveOrgSlug({
  orgId,
  name,
  tableName = Resource.OrgTable.name,
}: {
  orgId: string;
  name: string;
  tableName?: string;
}): Promise<ReservedOrgSlug> {
  const base = slugify(name) || 'org';

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!(await slugTaken(candidate, tableName))) {
      return { slug: candidate, reservationItem: reservationItem(candidate, orgId, tableName) };
    }
  }

  const fallback = `${base}-${crypto.randomUUID().slice(0, 8)}`;
  return { slug: fallback, reservationItem: reservationItem(fallback, orgId, tableName) };
}
