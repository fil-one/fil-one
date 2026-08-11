import type { OrgDeletionMember } from './dynamo-records.js';
import { getStripeClient } from './stripe-client.js';

// ---------------------------------------------------------------------------
// Live Stripe customer discovery for account teardown (FIL-112)
// ---------------------------------------------------------------------------
//
// Both paths that mint a Stripe customer — lib/create-billing-trial.ts and
// handlers/create-setup-intent.ts — stamp `metadata: { userId, orgId }` on it,
// which makes the customer findable from the org's member list alone.
//
// This replaces a confirm-time snapshot of the CUSTOMER# rows. That snapshot
// was structurally blind to a customer minted inside the deletion race windows
// (between the members read and the billing fence, or between the fence and
// the worker's purge): the CUSTOMER# row was then purged with the org and the
// customer's PII sat in Stripe unredacted forever. Discovery asks Stripe what
// exists NOW, so those late customers are cancelled and redacted like any
// other.

/**
 * The org's billing customer as Stripe currently reports it. The org ↔ Stripe
 * customer relationship is 1:1 by domain, so `extraCustomerIds` is an
 * invariant violation the caller must refuse to resolve on its own.
 */
interface DiscoveredBillingCustomer {
  /** The org's Stripe customer; absent when it never had one. */
  customerId?: string;
  /** Any further distinct customers found — an invariant violation. */
  extraCustomerIds: string[];
}

/**
 * Stripe's search query language quotes literals with `'`; it documents no
 * escape for a quote INSIDE one. A userId containing `'` (or any other
 * metacharacter) would therefore change the query's meaning rather than fail,
 * so unsearchable userIds are rejected, never escaped.
 */
const SEARCHABLE_USER_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Find the org's Stripe customer.
 *
 * Primary path: one search on `metadata['orgId']`. Both customer creators stamp it
 * (`create-billing-trial.ts`, `create-setup-intent.ts`), and the usage-reporting
 * worker re-stamps it on every daily run, which backfills customers that predate
 * the key.
 *
 * The per-member `metadata['userId']` search survives as a FALLBACK, used only when
 * the org-id search returns nothing. It exists for one remaining hole: an org whose
 * customer the worker never syncs — no active subscription, so the orchestrator's
 * scan never dispatches it — is never backfilled. When the fallback finds something
 * the org-id search missed it warns, and that log is what retires it: once it stays
 * silent, the fallback and the whole member loop can go.
 *
 * There is no fallback if a search FAILS: with the snapshot gone there is nothing to
 * fall back TO, and guessing "no customer" would silently skip cancellation and
 * redaction. A throw leaves the DELETION record non-DONE, so the worker retry / the
 * 12h orchestrator cron re-drives the whole idempotent teardown — and the stuck
 * gauge surfaces it if it never converges.
 *
 * Stripe Search indexes writes with a lag (~25s, measured 2026-08-07), so a customer
 * minted seconds before the confirm can be invisible to the first call. The caller's
 * second pass, run after the rest of teardown, covers it.
 */
export async function discoverBillingCustomer(
  orgId: string,
  members: OrgDeletionMember[],
): Promise<DiscoveredBillingCustomer> {
  const byOrg = await searchCustomers(orgId, `metadata['orgId']:'${orgId}'`, 'org id');
  if (byOrg.size > 0) return toResult(byOrg);

  const byMember = await searchByMember(orgId, members);
  if (byMember.size > 0) {
    console.warn(
      '[billing-customer-discovery] Found customer(s) by member userId that the orgId search ' +
        'missed — this customer was never backfilled by the usage worker. While this fires, the ' +
        'member fallback cannot be removed',
      { orgId, customerIds: [...byMember] },
    );
  }
  return toResult(byMember);
}

function toResult(discovered: Set<string>): DiscoveredBillingCustomer {
  const [customerId, ...extraCustomerIds] = [...discovered];
  return { ...(customerId ? { customerId } : {}), extraCustomerIds };
}

/** The fallback path: one search per member, keyed on `metadata.userId`. */
async function searchByMember(orgId: string, members: OrgDeletionMember[]): Promise<Set<string>> {
  // Insertion-ordered so the caller's "first distinct id" is stable across passes
  // for a given member order.
  const discovered = new Set<string>();
  for (const member of members) {
    if (!SEARCHABLE_USER_ID.test(member.userId)) {
      // Fail loud rather than skip. Skipping means this member's customer is never
      // found, so it is never cancelled and its PII is never redacted — and the
      // teardown still reports success.
      throw new Error(
        `Org ${orgId} has a member whose userId cannot be searched in Stripe ` +
          `(${member.userId}); refusing to complete a teardown that would skip them`,
      );
    }
    for (const id of await searchCustomers(
      orgId,
      `metadata['userId']:'${member.userId}'`,
      `member ${member.userId}`,
    )) {
      discovered.add(id);
    }
  }
  return discovered;
}

/**
 * One `customers.search`, walking every page. Customers whose metadata names a
 * DIFFERENT org are skipped: cancelling or redacting one would destroy a live
 * account's billing. Absent `orgId` is accepted — legacy customers predate it, and
 * they are the reason the member fallback still exists.
 */
async function searchCustomers(
  orgId: string,
  query: string,
  describeQuery: string,
): Promise<Set<string>> {
  const found = new Set<string>();
  try {
    for await (const customer of getStripeClient().customers.search({ query, limit: 100 })) {
      const customerOrgId = customer.metadata?.orgId;
      if (customerOrgId && customerOrgId !== orgId) {
        console.warn('[billing-customer-discovery] Skipping Stripe customer owned by another org', {
          orgId,
          query: describeQuery,
          customerId: customer.id,
          customerOrgId,
        });
        continue;
      }
      found.add(customer.id);
    }
  } catch (err) {
    throw new Error(
      `Stripe customer search failed for org ${orgId} (${describeQuery}); ` +
        'the next teardown pass retries',
      { cause: err },
    );
  }
  return found;
}
