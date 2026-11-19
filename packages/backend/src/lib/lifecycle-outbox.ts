import { createHash } from 'node:crypto';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Join the signup's durable outcome to its own transaction. Unlike the optional
 * customer audit event, this item stays in the retry-without-audit transaction.
 * No observer reconstructs an outcome from a billing or identity snapshot.
 */
export function buildSignupLifecycleOutbox({
  orgId,
  occurredAt,
  verifiedEmail,
}: {
  orgId: string;
  occurredAt: string;
  verifiedEmail?: string;
}): TransactWriteItem[] {
  const table = process.env.FILONE_LIFECYCLE_OUTBOX_TABLE;
  if (!table) return [];
  if (!OPAQUE_ID.test(orgId)) throw new Error('Invalid lifecycle Organization identifier');
  const timestamp = new Date(occurredAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== occurredAt) {
    throw new Error('Invalid lifecycle occurrence timestamp');
  }

  // Identity survives a producer retry with a newly constructed audit event.
  const eventId = `signup_${createHash('sha256').update(orgId).digest('hex')}`;
  const candidateDomain = verifiedEmail?.split('@');
  const domain = candidateDomain?.length === 2 ? candidateDomain[1].toLowerCase() : undefined;
  const detail = {
    schema_version: 1,
    event_id: eventId,
    event_type: 'organization.signup',
    occurred_at: occurredAt,
    organization_id: orgId,
    ...(domain && domain.length <= 253 && DOMAIN.test(domain) ? { email_domain: domain } : {}),
  };
  return [
    {
      Put: {
        TableName: table,
        Item: marshall({
          event_id: eventId,
          detail,
          expires_at: Math.ceil(timestamp.getTime() / 1000) + 180 * 86400,
        }),
        ConditionExpression: 'attribute_not_exists(event_id)',
      },
    },
  ];
}

/** A first-issuance milestone contains no URL, key, bucket, actor or request. */
export function buildFirstPresignLifecycleOutbox({
  orgId,
  occurredAt,
  provider,
  tenantId,
}: {
  orgId: string;
  occurredAt: string;
  provider: string;
  tenantId: string;
}): TransactWriteItem[] {
  const table = process.env.FILONE_LIFECYCLE_OUTBOX_TABLE;
  if (!table) return [];
  if ([orgId, provider, tenantId].some((id) => !OPAQUE_ID.test(id))) {
    throw new Error('Invalid lifecycle identity');
  }
  const timestamp = new Date(occurredAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== occurredAt) {
    throw new Error('Invalid lifecycle occurrence timestamp');
  }
  const eventId = `presign_${createHash('sha256').update(orgId).digest('hex')}`;
  return [
    {
      Put: {
        TableName: table,
        Item: marshall({
          event_id: eventId,
          detail: {
            schema_version: 1,
            event_id: eventId,
            event_type: 'presign.first_issued',
            occurred_at: occurredAt,
            organization_id: orgId,
            observed_tenant: { sp: provider, id: tenantId },
          },
          expires_at: Math.ceil(timestamp.getTime() / 1000) + 180 * 86400,
        }),
        ConditionExpression: 'attribute_not_exists(event_id)',
      },
    },
  ];
}
