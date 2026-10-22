import type Stripe from 'stripe';
import { ApiErrorCode } from '@filone/shared';
import type { SubscriptionRecord } from './dynamo-records.ts';
import { ResponseBuilder } from './response-builder.ts';
import { proceed, refuse } from './result.ts';
import type { Result } from './result.ts';
import { isStripeResourceMissing } from './stripe-client.ts';

/** What the activation response and the billing-record write read off the subscription. */
const EXPAND = ['latest_invoice.payment_intent', 'default_payment_method'];

/** Statuses of a subscription Stripe can still bill. */
const LIVE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
]);

export interface CreateOrUpdateSubscriptionParams {
  stripe: Stripe;
  record: SubscriptionRecord;
  paymentMethodId: string;
  priceId: string;
  userId: string;
  orgId: string;
  promotionCodeId?: string;
}

/**
 * Activates billing on the subscription the row names, as Stripe reports it
 * now. The row's own status cannot decide this: a `grace_period` row may stand
 * for a subscription Stripe already ended or for one that is still billing, and
 * creating beside a live one bills the customer twice.
 */
export async function createOrUpdateSubscription(
  params: CreateOrUpdateSubscriptionParams,
): Promise<Result<Stripe.Subscription>> {
  const { stripe, record } = params;
  const subscription = record.subscriptionId
    ? await retrieveIfExists(stripe, record.subscriptionId)
    : undefined;

  if (subscription && LIVE_STATUSES.has(subscription.status)) {
    return proceed(await updateLiveSubscription(params, subscription));
  }
  return createSubscription(params);
}

async function retrieveIfExists(
  stripe: Stripe,
  subscriptionId: string,
): Promise<Stripe.Subscription | undefined> {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    if (isStripeResourceMissing(err)) return undefined;
    throw err;
  }
}

async function updateLiveSubscription(
  { stripe, paymentMethodId, promotionCodeId }: CreateOrUpdateSubscriptionParams,
  subscription: Stripe.Subscription,
): Promise<Stripe.Subscription> {
  const { id } = subscription;
  const discountFollows = promotionCodeId !== undefined;
  const settlesAfter = subscription.status !== 'active';

  // The payment method goes on before anything that invoices, so the invoice is
  // charged to it rather than to a card that already failed.
  const attached = await stripe.subscriptions.update(id, {
    default_payment_method: paymentMethodId,
    ...(discountFollows || settlesAfter ? {} : { expand: EXPAND }),
  });
  // The discount gets its own update so it is in place before the next step
  // generates or pays an invoice; bundled, the invoice ordering is ambiguous.
  // It applies to invoices from here on: an overdue invoice was finalized
  // before the code was accepted, and is paid at its finalized amount.
  if (discountFollows) {
    await stripe.subscriptions.update(id, {
      discounts: [{ promotion_code: promotionCodeId }],
    });
  }

  switch (subscription.status) {
    case 'trialing':
      return stripe.subscriptions.update(id, { trial_end: 'now', expand: EXPAND });
    case 'past_due':
    case 'unpaid':
      await settleOpenInvoices(stripe, subscription, paymentMethodId);
      return stripe.subscriptions.retrieve(id, { expand: EXPAND });
    case 'paused':
      return resumeSubscription(stripe, id);
    default:
      return discountFollows ? stripe.subscriptions.retrieve(id, { expand: EXPAND }) : attached;
  }
}

/**
 * Resumes a paused subscription on a new billing period starting now. Stripe
 * charges the resumption invoice to the card just attached and leaves the
 * subscription paused if the charge fails; the caller sees its status and
 * answers 402.
 */
async function resumeSubscription(stripe: Stripe, id: string): Promise<Stripe.Subscription> {
  try {
    return await stripe.subscriptions.resume(id, {
      billing_cycle_anchor: { type: 'now' },
      payment_behavior: 'resume_on_payment_success',
      expand: EXPAND,
    });
  } catch (err) {
    if ((err as { type?: string }).type !== 'StripeCardError') throw err;
    return stripe.subscriptions.retrieve(id, { expand: EXPAND });
  }
}

/**
 * Pays what the subscription owes with the new card, which is what returns it
 * to `active`. An `unpaid` subscription has stopped advancing its invoices, so
 * its drafts are finalized first. A declined card leaves the subscription as it
 * was; the caller sees its status and answers 402.
 */
async function settleOpenInvoices(
  stripe: Stripe,
  subscription: Stripe.Subscription,
  paymentMethodId: string,
): Promise<void> {
  // Invoice ids are typed optional for preview invoices; a listed invoice always has one.
  if (subscription.status === 'unpaid') {
    const drafts = await stripe.invoices.list({ subscription: subscription.id, status: 'draft' });
    for (const draft of drafts.data) {
      await stripe.invoices.finalizeInvoice(draft.id!, { auto_advance: true });
    }
  }
  const open = await stripe.invoices.list({ subscription: subscription.id, status: 'open' });
  for (const invoice of open.data) {
    try {
      await stripe.invoices.pay(invoice.id!, { payment_method: paymentMethodId });
    } catch (err) {
      if ((err as { type?: string }).type !== 'StripeCardError') throw err;
      return;
    }
  }
}

async function createSubscription({
  stripe,
  record,
  paymentMethodId,
  priceId,
  userId,
  orgId,
  promotionCodeId,
}: CreateOrUpdateSubscriptionParams): Promise<Result<Stripe.Subscription>> {
  const customer = record.stripeCustomerId!;
  const stray = await findLiveSubscription(stripe, customer);
  if (stray) {
    console.error(
      '[activate-subscription] Customer has a live subscription the row does not name',
      {
        orgId,
        customer,
        namedSubscriptionId: record.subscriptionId,
        straySubscriptionId: stray.id,
        strayStatus: stray.status,
      },
    );
    return refuse(
      new ResponseBuilder()
        .status(409)
        .body({
          message:
            'Your account already has a subscription we could not match. Please contact support to reactivate it.',
          code: ApiErrorCode.SUBSCRIPTION_CONFLICT,
        })
        .build(),
    );
  }

  // Keyed by everything the create sends that can differ, so a double submit
  // returns the first subscription and a retry with another card or code is a
  // new request rather than an idempotency mismatch.
  const idempotencyKey = [
    'activate-org',
    orgId,
    record.subscriptionId ?? 'none',
    paymentMethodId,
    ...(promotionCodeId ? [promotionCodeId] : []),
  ].join('-');

  // The metadata is what every webhook writer resolves the org from. A
  // subscription created without it arrives at the webhook naming no org, and
  // that subscription's whole lifecycle — status changes, payment failures,
  // cancellation — cannot be written at all.
  return proceed(
    await stripe.subscriptions.create(
      {
        customer,
        items: [{ price: priceId }],
        default_payment_method: paymentMethodId,
        metadata: { userId, orgId },
        ...(promotionCodeId ? { discounts: [{ promotion_code: promotionCodeId }] } : {}),
        expand: EXPAND,
      },
      { idempotencyKey },
    ),
  );
}

async function findLiveSubscription(
  stripe: Stripe,
  customer: string,
): Promise<Stripe.Subscription | undefined> {
  // One customer per org holds a handful of subscriptions at most, so one page
  // covers them.
  const { data } = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
  return data.find((subscription) => LIVE_STATUSES.has(subscription.status));
}
