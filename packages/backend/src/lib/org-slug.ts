import {
  GetItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.ts';
import { getOrgProfile } from './org-profile.ts';

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

/**
 * Thrown by a {@link withSlugReservationRetry} `attempt` to report that its
 * transaction was cancelled specifically because the reservation it carried
 * lost a race — a concurrent create or rename claimed the candidate between
 * the availability probe and this transaction's commit. Anything else the
 * transaction can fail for should propagate as itself, not this.
 */
export class SlugReservationLost extends Error {
  constructor() {
    super('The slug reservation lost a race with a concurrent create or rename');
    this.name = 'SlugReservationLost';
  }
}

/**
 * Whether the `reservationItem` at `index` of a cancelled transaction's own
 * item list is what failed its condition — the same positional check
 * `update-org.ts`'s `renameConditionFailed` makes for the name item, applied
 * here to whichever index the caller placed the slug reservation at.
 */
export function slugReservationConditionFailed(err: unknown, index: number): boolean {
  return (
    err instanceof TransactionCanceledException &&
    err.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed'
  );
}

/** Bounded retries for a reservation that keeps losing races — never loops forever. */
const MAX_SLUG_RESERVATION_RETRIES = 5;

/**
 * Reserve a slug for `orgId` and hand it to `attempt`, retrying with a fresh
 * candidate whenever `attempt` reports — by throwing {@link SlugReservationLost}
 * — that its transaction was cancelled because this reservation specifically
 * lost a race.
 *
 * The probe in {@link reserveOrgSlug} only narrows the search; the write's own
 * `attribute_not_exists(pk)` condition is the real uniqueness check, and two
 * concurrent creates or renames that probed the same available candidate will
 * have exactly one of them lose it here. Without a retry that loser's whole
 * request fails — an otherwise valid signup or rename surfacing as a server
 * error over a slug collision neither caller could see coming.
 *
 * `attempt` is responsible for recognizing its own cancellation: it knows
 * where in its own transaction it placed the reservation item, this function
 * does not.
 */
export async function withSlugReservationRetry<T>({
  orgId,
  name,
  tableName = Resource.OrgTable.name,
  attempt,
}: {
  orgId: string;
  name: string;
  tableName?: string;
  attempt: (reserved: ReservedOrgSlug) => Promise<T>;
}): Promise<T> {
  for (let i = 0; i < MAX_SLUG_RESERVATION_RETRIES; i++) {
    const reserved = await reserveOrgSlug({ orgId, name, tableName });
    try {
      return await attempt(reserved);
    } catch (err) {
      const isLastAttempt = i === MAX_SLUG_RESERVATION_RETRIES - 1;
      if (!(err instanceof SlugReservationLost) || isLastAttempt) throw err;
    }
  }
  // Unreachable — the loop above always returns or throws.
  throw new SlugReservationLost();
}

/**
 * Backfill a slug for an org profile that predates the field, from the read
 * path rather than only via the standalone `backfill-org-slugs.ts` script.
 *
 * Deploying org-scoped routing depends on every existing org having a slug —
 * `legacy-route-redirect.ts` has nothing to build a scoped URL from
 * otherwise, and the bookmark or Auth0 callback that lands there renders a
 * not-found page. The standalone script closes that gap for the whole table
 * in one pass, but nothing in this repo wires it into a deploy, so a stage
 * that ships this route before the script has been run locks every
 * pre-existing account out until an operator remembers to run it. Calling
 * this from `GET /api/me` closes the same gap per-org, on whichever request
 * touches it first, with no deploy-ordering dependency at all — the script
 * remains useful for warming a stage in bulk, but nothing depends on it
 * having run.
 *
 * The write is conditioned on the row still lacking a slug, so two requests
 * racing this for the same org — or this racing a rename — leave the
 * winner's slug in place. When this call is the loser, the condition names
 * the row's current slug as the reason: read it back and return that,
 * rather than treating "someone already gave it one" as a failure.
 */
export async function ensureOrgSlug({
  orgId,
  name,
}: {
  orgId: string;
  name: string;
}): Promise<string> {
  return withSlugReservationRetry({
    orgId,
    name,
    attempt: async ({ slug, reservationItem }) => {
      try {
        await getDynamoClient().send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Update: {
                  TableName: Resource.UserInfoTable.name,
                  Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
                  UpdateExpression: 'SET slug = :slug',
                  ConditionExpression: 'attribute_not_exists(slug)',
                  ExpressionAttributeValues: { ':slug': { S: slug } },
                },
              },
              reservationItem,
            ],
          }),
        );
        return slug;
      } catch (err) {
        if (slugReservationConditionFailed(err, 0)) {
          // Not this reservation losing a race — the profile row already has
          // a slug, written by whoever got there first. Read it back instead
          // of erroring a caller who only wanted one to exist.
          const profile = await getOrgProfile(orgId, { consistentRead: true });
          return profile?.slug?.S || slug;
        }
        if (slugReservationConditionFailed(err, 1)) throw new SlugReservationLost();
        throw err;
      }
    },
  });
}
