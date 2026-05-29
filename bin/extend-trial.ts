#!/usr/bin/env node

// Usage: ./bin/extend-trial.ts <orgId> [days]
//
// Resets a test user's subscription back to a fresh `trialing` state across all
// stores that the grace-period transition touched:
//   - Stripe subscription (trial_end pushed into the future, or recreated if canceled)
//   - BillingTable subscription record (trialing + new trial dates, gracePeriodEndsAt cleared)
//   - Aurora tenant (status → ACTIVE via backoffice API)
//   - FTH client (status → active via the management API), when the org has an FTH tenant
// Refuses to run against the "production" stage.
//
// You can obtain the `orgId` UUID by inspecting the response to `GET /me`
// in browser dev tools.

import { execFileSync } from 'node:child_process';

const orgId = process.argv[2];
const daysArg = process.argv[3];
if (!orgId) {
  console.error('Usage: ./bin/extend-trial.ts <orgId> [days]');
  process.exit(1);
}
const days = daysArg ? Number(daysArg) : 30;
if (!Number.isFinite(days) || days <= 0) {
  console.error(`Invalid days: ${daysArg}`);
  process.exit(1);
}

// Re-exec under `sst shell` if SST resources aren't available
if (!process.env.SST_RESOURCE_App) {
  execFileSync('pnpx', ['sst', 'shell', 'node', import.meta.filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(0);
}

import { Resource } from 'sst';
import { readFileSync } from 'node:fs';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import Stripe from 'stripe';
import { createClient, setTenantStatus } from '@filone/aurora-backoffice-client';

const PROTECTED_STAGES = ['production'];

const stage = readFileSync('.sst/stage', 'utf8').trim();
if (PROTECTED_STAGES.includes(stage)) {
  console.error(`Refusing to modify data in the "${stage}" stage.`);
  process.exit(1);
}

// Aurora backoffice + FTH management config — non-prod only. The stage guard
// above blocks production; we deliberately do not encode production URLs here.
// `sst shell` does not export Lambda-scoped env vars, so we set them locally.
const AURORA_BACKOFFICE_URL = 'https://api-backoffice.dev.aur.lu/api';
const AURORA_PARTNER_ID = 'ff';
const FTH_MANAGEMENT_API_URL = 'https://api.fortilyx.com';

const dynamo = new DynamoDBClient({});
const stripe = new Stripe(Resource.StripeSecretKey.value);
const auroraClient = createClient({
  baseUrl: AURORA_BACKOFFICE_URL,
  headers: { 'X-Api-Key': Resource.AuroraBackofficeToken.value },
});

// 1. Resolve orgId → userId + tenant ids via UserInfoTable[ORG#{orgId}/PROFILE]
const orgRes = await dynamo.send(
  new GetItemCommand({
    TableName: Resource.UserInfoTable.name,
    Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    ProjectionExpression: 'createdBy, auroraTenantId, fthTenantId',
  }),
);
const userId = orgRes.Item?.createdBy?.S;
const auroraTenantId = orgRes.Item?.auroraTenantId?.S;
const fthTenantId = orgRes.Item?.fthTenantId?.S;
if (!userId) {
  console.error(`No org PROFILE record (or no createdBy) for orgId="${orgId}"`);
  process.exit(1);
}
if (!auroraTenantId) {
  console.error(`No auroraTenantId on org ${orgId}; tenant setup may be incomplete`);
  process.exit(1);
}

// 2. Read current subscription
const subRes = await dynamo.send(
  new GetItemCommand({
    TableName: Resource.BillingTable.name,
    Key: { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } },
  }),
);
if (!subRes.Item) {
  console.error(`No SUBSCRIPTION record for userId="${userId}" (orgId="${orgId}")`);
  process.exit(1);
}
const stripeCustomerId = subRes.Item.stripeCustomerId?.S;
const subscriptionId = subRes.Item.subscriptionId?.S;
if (!stripeCustomerId || !subscriptionId) {
  console.error(`Missing stripeCustomerId or subscriptionId on subscription record`);
  process.exit(1);
}

console.log(`Stage: ${stage}`);
console.log(`Org:   ${orgId}`);
console.log(`User:  ${userId}\n`);
console.log('Before:');
console.log(`  subscriptionStatus:   ${subRes.Item.subscriptionStatus?.S ?? '(unset)'}`);
console.log(`  trialStartedAt:       ${subRes.Item.trialStartedAt?.S ?? '(unset)'}`);
console.log(`  trialEndsAt:          ${subRes.Item.trialEndsAt?.S ?? '(unset)'}`);
console.log(`  gracePeriodEndsAt:    ${subRes.Item.gracePeriodEndsAt?.S ?? '(unset)'}`);
console.log(`  stripeSubscriptionId: ${subscriptionId}\n`);

// 3. Compute new trial dates
const now = new Date();
const trialEndsAt = new Date(now.getTime() + days * 86_400_000);
const trialEndsAtUnix = Math.floor(trialEndsAt.getTime() / 1000);

// 4. Stripe — extend trial on the existing subscription, or recreate if it was canceled
let activeSubscriptionId = subscriptionId;
const currentSub = await stripe.subscriptions.retrieve(subscriptionId);
if (currentSub.status === 'canceled') {
  console.log(
    `Stripe sub ${subscriptionId} is canceled — creating a fresh trialing subscription...`,
  );
  const fresh = await stripe.subscriptions.create({
    customer: stripeCustomerId,
    items: [{ price: Resource.StripePriceId.value }],
    trial_end: trialEndsAtUnix,
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    metadata: { userId, orgId },
  });
  activeSubscriptionId = fresh.id;
} else {
  await stripe.subscriptions.update(subscriptionId, {
    trial_end: trialEndsAtUnix,
    proration_behavior: 'none',
  });
}

// 5. Reset BillingTable in a single atomic write
await dynamo.send(
  new UpdateItemCommand({
    TableName: Resource.BillingTable.name,
    Key: { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } },
    UpdateExpression:
      'SET subscriptionStatus = :status, subscriptionId = :subId, trialStartedAt = :start, trialEndsAt = :end, updatedAt = :now ' +
      'REMOVE gracePeriodEndsAt, canceledAt, lastPaymentFailedAt',
    ExpressionAttributeValues: {
      ':status': { S: 'trialing' },
      ':subId': { S: activeSubscriptionId },
      ':start': { S: now.toISOString() },
      ':end': { S: trialEndsAt.toISOString() },
      ':now': { S: now.toISOString() },
    },
  }),
);

// 6. Unlock Aurora tenant via backoffice API
const { error: auroraError, response: auroraResponse } = await setTenantStatus({
  client: auroraClient,
  path: { partnerId: AURORA_PARTNER_ID, tenantId: auroraTenantId },
  body: { status: 'ACTIVE' },
  throwOnError: false,
});
if (auroraError) {
  console.error('Failed to unlock Aurora tenant.');
  if (auroraResponse) {
    console.error(`  HTTP ${auroraResponse.status} ${auroraResponse.statusText}`);
  } else {
    console.error('  No HTTP response — fetch failed (DNS / connection / TLS).');
  }
  console.error('  error:', auroraError);
  process.exit(1);
}

// 7. Unlock FTH client via the management API (only if the org has an FTH tenant).
// FTH is a peer orchestrator in non-prod stages; mirror the Aurora unlock so the
// account is re-activated everywhere it exists.
let fthStatusLine = '(no FTH tenant)';
if (fthTenantId) {
  const fthResponse = await fetch(
    `${FTH_MANAGEMENT_API_URL}/management/v1/clients/${encodeURIComponent(fthTenantId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${Resource.FthManagementApiToken.value}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'active' }),
    },
  );
  if (!fthResponse.ok) {
    console.error('Failed to unlock FTH client.');
    console.error(`  HTTP ${fthResponse.status} ${fthResponse.statusText}`);
    console.error('  body:', await fthResponse.text());
    process.exit(1);
  }
  fthStatusLine = 'active (set via FTH management API)';
}

console.log('After:');
console.log(`  subscriptionStatus:   trialing`);
console.log(`  trialStartedAt:       ${now.toISOString()}`);
console.log(`  trialEndsAt:          ${trialEndsAt.toISOString()}`);
console.log(`  gracePeriodEndsAt:    (cleared)`);
console.log(`  aurora tenant status: ACTIVE (set via Aurora backoffice)`);
console.log(`  fth client status:    ${fthStatusLine}`);
console.log(`  stripeSubscriptionId: ${activeSubscriptionId}\n`);
console.log('Done.');
