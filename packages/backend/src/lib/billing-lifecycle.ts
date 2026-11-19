import { createHash } from 'node:crypto';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { getDynamoClient } from './ddb-client.ts';
import { readLifecycleCustomerBinding } from './lifecycle-customer-binding.ts';
import { reportMetric } from './metrics.ts';

interface BillingLifecycleDetail {
  schema_version: 1;
  event_id: string;
  event_type: 'trial.started' | 'payment.succeeded' | 'payment.failed' | 'payment.method_added';
  occurred_at: string;
  organization_id: string;
}
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

function isPositiveMinorAmount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function assertBillingObject(
  object: Record<string, unknown>,
  expected: 'subscription' | 'invoice' | 'payment_method',
): void {
  if (object.object !== expected) throw new Error('Invalid billing lifecycle object');
}

function readOrganization(...metadata: unknown[]): string {
  const candidates = metadata
    .map((value) => readRecord(value).orgId)
    .filter((value) => value !== undefined && value !== '');
  if (
    !candidates.length ||
    candidates.some((value) => typeof value !== 'string' || !TOKEN.test(value))
  ) {
    throw new Error('Billing lifecycle Organization metadata unavailable');
  }
  const distinct = new Set(candidates);
  if (distinct.size !== 1) throw new Error('Billing lifecycle Organization metadata conflicts');
  // Every candidate was validated as a nonempty opaque string above.
  return candidates[0] as string;
}

function readInvoiceOrganization(invoice: Record<string, unknown>): string {
  const parent = readRecord(invoice.parent);
  const subscription = readRecord(parent.subscription_details);
  const legacySubscription = readRecord(invoice.subscription_details);
  return readOrganization(
    invoice.metadata,
    parent.type === 'subscription_details' ? subscription.metadata : undefined,
    legacySubscription.metadata,
  );
}

/** Build only from the original signature-verified event retained in the FIFO queue. */
export function buildBillingLifecycleDetail(raw: unknown): BillingLifecycleDetail | undefined {
  const event = readRecord(raw);
  const object = readRecord(readRecord(event.data).object);
  let kind: BillingLifecycleDetail['event_type'];
  let organizationId: string;
  let occurredAt = event.created;
  switch (event.type) {
    case 'customer.subscription.created':
      assertBillingObject(object, 'subscription');
      if (object.status !== 'trialing') return;
      kind = 'trial.started';
      organizationId = readOrganization(object.metadata);
      occurredAt = object.trial_start;
      break;
    case 'invoice.payment_succeeded':
      assertBillingObject(object, 'invoice');
      // A free/trial invoice is not evidence that a customer actually paid.
      if (object.status !== 'paid' || !isPositiveMinorAmount(object.amount_paid)) return;
      kind = 'payment.succeeded';
      organizationId = readInvoiceOrganization(object);
      break;
    case 'invoice.payment_failed':
      assertBillingObject(object, 'invoice');
      if (!isPositiveMinorAmount(object.amount_due)) return;
      kind = 'payment.failed';
      organizationId = readInvoiceOrganization(object);
      break;
    default:
      return;
  }
  return createBillingDetail(event, kind, organizationId, occurredAt);
}

function createBillingDetail(
  event: Record<string, unknown>,
  kind: BillingLifecycleDetail['event_type'],
  organizationId: string,
  occurredAt: unknown,
): BillingLifecycleDetail {
  if (
    typeof event.id !== 'string' ||
    !TOKEN.test(event.id) ||
    typeof occurredAt !== 'number' ||
    !Number.isSafeInteger(occurredAt) ||
    occurredAt <= 0
  ) {
    throw new Error('Billing lifecycle event identity or occurrence unavailable');
  }
  return {
    schema_version: 1,
    event_id: `billing_${createHash('sha256').update(event.id).digest('hex')}`,
    event_type: kind,
    occurred_at: new Date(occurredAt * 1000).toISOString(),
    organization_id: organizationId,
  };
}

function emitAttachmentCoverageGap(
  reason: 'disabled' | 'unbound' | 'expired' | 'predates-binding' | 'unsupported-customer',
): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['Reason']],
          Metrics: [{ Name: 'LifecycleAttachmentCoverageGap', Unit: 'Count' }],
        },
      ],
    },
    Reason: reason,
    LifecycleAttachmentCoverageGap: 1,
  });
}

async function buildAttachmentLifecycleDetail(
  raw: unknown,
): Promise<BillingLifecycleDetail | undefined> {
  const event = readRecord(raw);
  const object = readRecord(readRecord(event.data).object);
  assertBillingObject(object, 'payment_method');
  const customer =
    typeof object.customer === 'string' ? object.customer : readRecord(object.customer).id;
  if (typeof customer !== 'string' || !TOKEN.test(customer) || !customer.startsWith('cus_')) {
    emitAttachmentCoverageGap('unsupported-customer');
    return;
  }
  if (
    typeof event.created !== 'number' ||
    !Number.isSafeInteger(event.created) ||
    event.created <= 0
  ) {
    throw new Error('Invalid lifecycle attachment occurrence');
  }
  const binding = await readLifecycleCustomerBinding(customer, event.created);
  if (binding.status !== 'bound') {
    // Missing binding is outside-or-unknown cohort, not proof of complete
    // coverage. Do not stall unrelated billing in the FIFO customer group.
    emitAttachmentCoverageGap(binding.status);
    return;
  }
  return createBillingDetail(event, 'payment.method_added', binding.organizationId, event.created);
}

/**
 * Persist before the verified FIFO event is acknowledged. If this write fails,
 * the existing queue retries the original event even after business writes land.
 */
export async function captureBillingLifecycle(raw: unknown): Promise<void> {
  const table = process.env.FILONE_LIFECYCLE_BILLING_OUTBOX_TABLE;
  if (!table) return;
  const detail =
    readRecord(raw).type === 'payment_method.attached'
      ? await buildAttachmentLifecycleDetail(raw)
      : buildBillingLifecycleDetail(raw);
  if (!detail) return;
  const fingerprint = createHash('sha256').update(JSON.stringify(detail)).digest('hex');
  try {
    await getDynamoClient().send(
      new PutItemCommand({
        TableName: table,
        Item: marshall({
          event_id: detail.event_id,
          detail,
          fingerprint,
          expires_at: Math.ceil(Date.now() / 1000) + 180 * 86400,
        }),
        // An identical retry may renew retention, but never replace its payload.
        // Duplicate overwrites yield MODIFY, ignored by the INSERT-only publisher.
        ConditionExpression: 'attribute_not_exists(event_id) OR fingerprint = :fingerprint',
        ExpressionAttributeValues: { ':fingerprint': { S: fingerprint } },
      }),
    );
  } catch {
    throw new Error('Billing lifecycle outbox unavailable');
  }
}
