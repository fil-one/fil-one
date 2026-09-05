import { DeleteItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import Stripe from 'stripe';
import {
  PAID_GRACE_DAYS,
  SubscriptionStatus,
  TRIAL_GRACE_DAYS,
  mapStripeStatus,
} from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { resolveOrgId, resolveOrgIdFromSubscription } from '../lib/billing-org-lookup.js';
import { startDeletionFromStripe } from '../lib/deletion-from-stripe.js';
import {
  assertRegionSyncSucceeded,
  syncTenantStatusInProvisionedRegions,
  WEBHOOK_STATUS_SYNC_RETRY,
} from '../lib/region-helpers.js';
import {
  invoiceSubscriptionId,
  invoiceSubscriptionMetadata,
  subscriptionSuperseded,
} from '../lib/billing-identity.js';
import { getStripeClient, getWebhookSecret } from '../lib/stripe-client.js';
import { updateSubscriptionByUser } from '../lib/subscription-store.js';
import {
  emitBillingRowMissing,
  emitDunningEscalation,
  emitInvoiceFinalizationFailed,
  emitInvoiceFinalized,
  emitInvoicePaid,
} from '../lib/stripe-webhook-metrics.js';

const dynamo = getDynamoClient();

/**
 * Stripe webhook handler — NO auth middleware.
 * Verifies Stripe signature, processes billing events, and writes to billing table.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const tableName = Resource.BillingTable.name;
  const stripe = getStripeClient();

  // 1. Get raw body for signature verification
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '');

  const signatureHeader = event.headers['stripe-signature'];

  if (!signatureHeader) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Missing stripe-signature header' }),
    };
  }

  // 2. Verify webhook signature
  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      await getWebhookSecret(),
    );
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err);
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid signature' }) };
  }

  // 3. Idempotency — atomic claim-or-skip
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
  const idempotencyKey = { pk: { S: `WEBHOOK#${stripeEvent.id}` }, sk: { S: 'EVENT' } };
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          pk: `WEBHOOK#${stripeEvent.id}`,
          sk: 'EVENT',
          eventType: stripeEvent.type,
          processedAt: new Date().toISOString(),
          ttl,
        }),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.warn('[stripe-webhook] Already processed event:', stripeEvent.id);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }
    console.error('[stripe-webhook] Idempotency check failed:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Idempotency check error' }) };
  }

  // 4. Process event
  try {
    await processStripeEvent(stripeEvent);
  } catch (err) {
    console.error('[stripe-webhook] Error processing event:', err);
    // Release idempotency claim so Stripe retries can reprocess
    try {
      await dynamo.send(new DeleteItemCommand({ TableName: tableName, Key: idempotencyKey }));
    } catch (deleteErr) {
      console.error('[stripe-webhook] Failed to release idempotency claim:', deleteErr);
    }
    return { statusCode: 500, body: JSON.stringify({ message: 'Processing error' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
}

async function processStripeEvent(stripeEvent: Stripe.Event): Promise<void> {
  switch (stripeEvent.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = stripeEvent.data.object as Stripe.Subscription;
      await handleSubscriptionUpdate(subscription);
      return;
    }
    case 'customer.subscription.deleted': {
      const subscription = stripeEvent.data.object as Stripe.Subscription;
      await handleSubscriptionDeleted(subscription);
      return;
    }
    case 'customer.updated': {
      const customer = stripeEvent.data.object as Stripe.Customer;
      await handleCustomerUpdated(customer);
      return;
    }
    case 'customer.deleted': {
      const customer = stripeEvent.data.object as Stripe.Customer;
      await handleCustomerDeleted(customer);
      return;
    }
    case 'customer.subscription.trial_will_end': {
      const subscription = stripeEvent.data.object as Stripe.Subscription;
      console.log('[stripe-webhook] Trial ending soon for customer:', subscription.customer);
      return;
    }
    case 'invoice.payment_succeeded': {
      const invoice = stripeEvent.data.object as Stripe.Invoice;
      await handlePaymentSucceeded(invoice);
      return;
    }
    case 'invoice.payment_failed': {
      const invoice = stripeEvent.data.object as Stripe.Invoice;
      await handlePaymentFailed(invoice);
      return;
    }
    case 'invoice.finalized': {
      emitInvoiceFinalized();
      return;
    }
    case 'invoice.finalization_failed': {
      const invoice = stripeEvent.data.object as Stripe.Invoice;
      emitInvoiceFinalizationFailed(invoice.last_finalization_error?.code ?? 'unknown');
      return;
    }
    default:
      console.log('[stripe-webhook] Unhandled event type:', stripeEvent.type);
  }
}

function getCustomerIdString(customer: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof customer === 'string' ? customer : customer.id;
}

/**
 * Webhook writers upsert billing records, and a record created here without an
 * orgId is invisible to every lifecycle job (usage reporting, drift checking,
 * grace enforcement all skip records lacking one). Backfill it from Stripe
 * metadata whenever it is in hand — if_not_exists so a known-good stored value
 * is never clobbered. Returns the SET clause fragment and its value, empty when
 * the metadata carries no orgId.
 */
function orgIdBackfill(orgId: string | undefined): {
  clause: string;
  values: Record<string, { S: string }>;
} {
  if (!orgId) return { clause: '', values: {} };
  return {
    clause: ', orgId = if_not_exists(orgId, :orgId)',
    values: { ':orgId': { S: orgId } },
  };
}

async function handleCustomerUpdated(customer: Stripe.Customer): Promise<void> {
  const userId = customer.metadata?.userId;
  if (!userId) {
    throw new Error(`[stripe-webhook] No userId in metadata for customer: ${customer.id}`);
  }

  const defaultPm = customer.invoice_settings?.default_payment_method;
  if (!defaultPm) {
    console.info('[stripe-webhook] customer.updated without default_payment_method; skipping', {
      customerId: customer.id,
      userId,
    });
    return;
  }

  // Nothing stamped `metadata.orgId` onto customers created before the metadata
  // existed, and the re-key made no Stripe calls — so the daily usage worker's
  // metadata writes generate `customer.updated` for those customers forever.
  // Asking the billing row is the same fallback `customer.deleted` already
  // takes: the legacy `CUSTOMER#{userId}` row carries the orgId the backfill
  // keyed its copy by.
  const orgId = resolveOrgId(customer.metadata) ?? (await resolveOrgIdFromSubscription(userId));
  if (!orgId) {
    // Not a throw. The rows with no `orgId` were enumerated and dispositioned
    // by name before the re-key (docs/BillingRekeyRunbook.md), so no retry
    // converges on an answer — Stripe would redeliver this for three days and
    // then disable the endpoint over a card that no row can record.
    console.error('[stripe-webhook] customer.updated resolves to no org; payment method dropped', {
      customerId: customer.id,
      userId,
    });
    return;
  }

  const stripe = getStripeClient();
  const pm =
    typeof defaultPm === 'string' ? await stripe.paymentMethods.retrieve(defaultPm) : defaultPm;
  await updatePaymentMethod({ userId, orgId }, pm);
}

async function updatePaymentMethod(
  owner: { userId: string; orgId: string },
  pm: Stripe.PaymentMethod,
): Promise<void> {
  // A missing row is swallowed here rather than failing the webhook. The store
  // refuses to create one, and every other writer treats that refusal as an
  // error — but this one carries a card's last four digits and expiry, and a
  // 500 buys three days of Stripe retries and alert noise to redeliver them.
  // Post-verify the state is near-impossible; the metric is how anyone would
  // learn it happened at all.
  const { written } = await updateSubscriptionByUser(owner, {
    UpdateExpression:
      'SET paymentMethodId = :pmId, paymentMethodLast4 = :last4, paymentMethodBrand = :brand, paymentMethodExpMonth = :expMonth, paymentMethodExpYear = :expYear, updatedAt = :now',
    ExpressionAttributeValues: {
      ':pmId': { S: pm.id },
      ':last4': { S: pm.card?.last4 ?? '' },
      ':brand': { S: pm.card?.brand ?? '' },
      ':expMonth': { N: String(pm.card?.exp_month ?? 0) },
      ':expYear': { N: String(pm.card?.exp_year ?? 0) },
      ':now': { S: new Date().toISOString() },
    },
    tolerateMissingRow: true,
    guardAgainstScrub: { caller: 'customer.updated' },
  });

  if (!written) {
    emitBillingRowMissing('customer.updated');
    console.error('[stripe-webhook] No billing row to record the payment method on', {
      userId: owner.userId,
      orgId: owner.orgId,
    });
  }
}

async function handleCustomerDeleted(customer: Stripe.Customer): Promise<void> {
  // The customer.deleted payload carries the full pre-deletion Customer, including metadata.
  // We do NOT retrieve from Stripe — the customer no longer exists there.
  const userId = customer.metadata?.userId;
  if (!userId) {
    console.error('[stripe-webhook] customer.deleted has no metadata.userId; cannot resolve it', {
      customerId: customer.id,
    });
    return;
  }

  // Deleting the customer in Stripe is an admin action against trial abuse, and
  // terminating the account is its intended meaning — so this starts the full
  // teardown rather than just disabling tenants. metadata.orgId is written at
  // customer creation; the billing-row lookup covers customers that predate it.
  await startDeletionFromStripe({
    userId,
    customerId: customer.id,
    orgId: customer.metadata?.orgId,
    caller: 'customer.deleted',
  });

  emitDunningEscalation({ stage: 'canceled', reason: 'customer_deleted', attemptCount: 0 });
}

async function handleSubscriptionUpdate(subscription: Stripe.Subscription): Promise<void> {
  const customerId = getCustomerIdString(subscription.customer);
  const mappedStatus = mapStripeStatus(subscription.status);

  if (mappedStatus === null) {
    console.warn('[stripe-webhook] Unmappable Stripe status, skipping update', {
      stripeStatus: subscription.status,
      subscriptionId: subscription.id,
      customerId,
    });
    return;
  }

  // Find billing record by Stripe customer ID — we need to scan or use a GSI.
  // For MVP, use metadata.userId set during customer creation.
  // Empty-string metadata reads the same as absent, here and in resolveOrgId.
  const eventUserId = subscription.metadata?.userId || undefined;
  const eventOrgId = resolveOrgId(subscription.metadata);

  // The event already names the org the row is keyed by, so it addresses the
  // write on its own and the Stripe call is skipped.
  if (eventUserId && eventOrgId) {
    await updateBillingRecord({
      userId: eventUserId,
      subscription,
      mappedStatus,
      orgId: eventOrgId,
    });
    return;
  }

  // Whatever the subscription is missing, the customer may still carry: a
  // subscription created before the metadata stamped an orgId names none, and
  // the org is the key the row is written under. Fetch the customer and resolve
  // against both — writing with no org resolves nothing and throws
  // MissingOrgIdError, which Stripe would retry forever.
  const stripe = getStripeClient();
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) {
    console.warn('[stripe-webhook] Customer deleted, skipping subscription update', {
      customerId,
      subscriptionId: subscription.id,
    });
    return;
  }
  const userId = eventUserId ?? customer.metadata?.userId;
  if (!userId) {
    console.warn('[stripe-webhook] No userId in metadata for customer:', customerId);
    return;
  }
  await updateBillingRecord({
    userId,
    subscription,
    mappedStatus,
    orgId: resolveOrgId(subscription.metadata, customer.metadata),
  });
}

interface UpdateBillingRecordParams {
  userId: string;
  subscription: Stripe.Subscription;
  mappedStatus: SubscriptionStatus;
  orgId: string | undefined;
}

async function updateBillingRecord({
  userId,
  subscription,
  mappedStatus,
  orgId,
}: UpdateBillingRecordParams): Promise<void> {
  const backfill = orgIdBackfill(orgId);
  await updateSubscriptionByUser(
    { userId, orgId },
    {
      UpdateExpression: `SET subscriptionId = :subId, subscriptionStatus = :status, currentPeriodEnd = :periodEnd, currentPeriodStart = :periodStart, updatedAt = :now${backfill.clause} REMOVE gracePeriodEndsAt, canceledAt`,
      ExpressionAttributeValues: {
        ':subId': { S: subscription.id },
        ':status': { S: mappedStatus },
        ':periodEnd': {
          S: new Date((subscription.items.data[0]?.current_period_end ?? 0) * 1000).toISOString(),
        },
        ':periodStart': {
          S: new Date((subscription.items.data[0]?.current_period_start ?? 0) * 1000).toISOString(),
        },
        ':now': { S: new Date().toISOString() },
        ...backfill.values,
      },
      guardAgainstScrub: { caller: 'subscription.updated' },
    },
  );
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const stripe = getStripeClient();
  const customerId = getCustomerIdString(subscription.customer);
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) {
    // The customer is gone (deleted before/with this cancellation), so there
    // is no grace period to grant — close out the record the same way
    // customer.deleted does. This is the fallback when the customer.deleted
    // event itself was never delivered (e.g. the endpoint was not subscribed
    // to it at the time).
    const userId = subscription.metadata?.userId;
    if (!userId) {
      console.error(
        '[stripe-webhook] subscription.deleted for a deleted customer has no metadata.userId',
        { customerId, subscriptionId: subscription.id },
      );
      return;
    }
    // A deleted customer carries no metadata, so the subscription's is the only
    // one there is; startDeletionFromStripe's row fallback covers the rest.
    await startDeletionFromStripe({
      userId,
      customerId,
      orgId: subscription.metadata?.orgId,
      caller: 'subscription.deleted',
    });
    emitDunningEscalation({ stage: 'canceled', reason: 'customer_deleted', attemptCount: 0 });
    return;
  }

  const userId = customer.metadata?.userId;
  if (!userId) return;

  const graceDays = subscription.trial_end ? TRIAL_GRACE_DAYS : PAID_GRACE_DAYS;

  const now = new Date();
  const gracePeriodEndsAt = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000).toISOString();

  // Resolved once: the same org id keys the write below and the tenant
  // write-lock after it.
  const orgId = resolveOrgId(subscription.metadata, customer.metadata);
  if (
    await subscriptionSuperseded({
      source: 'customer.subscription.deleted',
      userId,
      orgId,
      subscriptionId: subscription.id,
    })
  ) {
    return;
  }

  const backfill = orgIdBackfill(orgId);
  await updateSubscriptionByUser(
    { userId, orgId },
    {
      UpdateExpression: `SET subscriptionStatus = :status, canceledAt = :now, gracePeriodEndsAt = :grace, updatedAt = :now${backfill.clause}`,
      ExpressionAttributeValues: {
        ':status': { S: SubscriptionStatus.GracePeriod },
        ':now': { S: now.toISOString() },
        ':grace': { S: gracePeriodEndsAt },
        ...backfill.values,
      },
      guardAgainstScrub: { caller: 'subscription.deleted' },
    },
  );

  const latestInvoice = subscription.latest_invoice;
  const attemptCount =
    latestInvoice && typeof latestInvoice !== 'string' ? latestInvoice.attempt_count : undefined;
  emitDunningEscalation({
    stage: 'canceled',
    reason: subscription.cancellation_details?.reason ?? 'unknown',
    attemptCount: attemptCount ?? 0,
  });

  // Best-effort: write-lock the tenant on every orchestrator during grace
  // period. If this fails, the daily grace-period-enforcer cron will also
  // attempt WRITE_LOCK for active grace periods missing it. The sync never
  // downgrades a tenant that is already disabled.
  try {
    if (orgId) {
      assertRegionSyncSucceeded(
        await syncTenantStatusInProvisionedRegions(
          orgId,
          'write-locked',
          WEBHOOK_STATUS_SYNC_RETRY,
        ),
      );
      console.log('[stripe-webhook] Tenant write-locked', { userId, orgId });
    }
  } catch (error) {
    console.error('[stripe-webhook] Failed to write-lock tenant', { userId, error });
  }
}

async function handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  if (!invoice.customer) return;
  const stripe = getStripeClient();
  const customerId = getCustomerIdString(invoice.customer);
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) return;

  const userId = customer.metadata?.userId;
  if (!userId) return;

  // The invoice's own subscription snapshot answers first, for the reason every
  // subscription path prefers it: a customer can outlive an org, and the
  // subscription that generated this invoice cannot.
  const orgId = resolveOrgId(invoiceSubscriptionMetadata(invoice), customer.metadata);

  // A success is destructive in the other direction: on the shared org row, a
  // late invoice from a replaced subscription would mark the org active and
  // re-enable its tenants while the authoritative subscription is past due.
  if (
    await subscriptionSuperseded({
      source: 'invoice.payment_succeeded',
      userId,
      orgId,
      subscriptionId: invoiceSubscriptionId(invoice),
    })
  ) {
    return;
  }

  const backfill = orgIdBackfill(orgId);
  const updateResult = await updateSubscriptionByUser(
    { userId, orgId },
    {
      UpdateExpression: `SET subscriptionStatus = :active, lastPaymentAt = :now, updatedAt = :now${backfill.clause} REMOVE gracePeriodEndsAt, lastPaymentFailedAt, canceledAt`,
      ExpressionAttributeValues: {
        ':active': { S: SubscriptionStatus.Active },
        ':now': { S: new Date().toISOString() },
        ...backfill.values,
      },
      ReturnValues: 'ALL_OLD',
      guardAgainstScrub: { caller: 'invoice.paid' },
    },
  );

  // The prior status comes from the row the guard reads, so a recovery is
  // reported off the record that governs access.
  const priorStatus = updateResult.previous?.subscriptionStatus?.S;
  if (
    priorStatus === SubscriptionStatus.PastDue ||
    priorStatus === SubscriptionStatus.GracePeriod
  ) {
    emitDunningEscalation({
      stage: 'recovered',
      reason: priorStatus,
      attemptCount: invoice.attempt_count ?? 0,
    });
  }

  emitInvoicePaid();

  // Best-effort: re-enable the tenant on every orchestrator if recovering from
  // PastDue/GracePeriod. If this fails, the tenant may remain locked until
  // manual intervention. A refused write means the teardown owns this account:
  // the tenant it disabled stays disabled.
  try {
    if (orgId && !updateResult.refused) {
      assertRegionSyncSucceeded(
        await syncTenantStatusInProvisionedRegions(orgId, 'active', WEBHOOK_STATUS_SYNC_RETRY),
      );
      console.log('[stripe-webhook] Tenant re-activated', { userId, orgId });
    }
  } catch (error) {
    console.error('[stripe-webhook] Failed to re-activate tenant', { userId, error });
  }
}

async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  if (!invoice.customer) return;
  const stripe = getStripeClient();
  const customerId = getCustomerIdString(invoice.customer);
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) return;

  const userId = customer.metadata?.userId;
  if (!userId) return;

  // Set PastDue but do NOT start grace period — Stripe Smart Retries will
  // continue attempting payment. Grace period only begins when Stripe cancels
  // the subscription after all retries are exhausted.
  const now = new Date().toISOString();
  // The invoice's own subscription snapshot answers first, for the reason every
  // subscription path prefers it: a customer can outlive an org, and the
  // subscription that generated this invoice cannot.
  const orgId = resolveOrgId(invoiceSubscriptionMetadata(invoice), customer.metadata);
  if (
    await subscriptionSuperseded({
      source: 'invoice.payment_failed',
      userId,
      orgId,
      subscriptionId: invoiceSubscriptionId(invoice),
    })
  ) {
    return;
  }

  const backfill = orgIdBackfill(orgId);
  await updateSubscriptionByUser(
    { userId, orgId },
    {
      UpdateExpression: `SET subscriptionStatus = :status, lastPaymentFailedAt = :failedAt, updatedAt = :now${backfill.clause}`,
      ExpressionAttributeValues: {
        ':status': { S: SubscriptionStatus.PastDue },
        ':failedAt': { S: now },
        ':now': { S: now },
        ...backfill.values,
      },
      guardAgainstScrub: { caller: 'invoice.payment_failed' },
    },
  );

  const attemptCount = invoice.attempt_count ?? 0;
  emitDunningEscalation({
    stage: attemptCount <= 1 ? 'entered' : 'retry',
    reason: invoice.last_finalization_error?.code ?? 'unknown',
    attemptCount: attemptCount,
  });
}
