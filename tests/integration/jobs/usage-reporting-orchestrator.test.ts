import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createTestCustomer, getStripeClient } from '../helpers.js';
import {
  AURORA_TEST_TENANT_ID,
  invokeOrchestrator,
  seedUserProfile,
  deleteUserProfile,
  seedSubscriptionRecord,
  deleteSubscriptionRecord,
  pollForAuditRecord,
  deleteAuditRecord,
  getAuditRecord,
} from './helpers.js';

const reportDate = new Date().toISOString().split('T')[0];

describe('Usage Reporting Orchestrator (direct Lambda invoke)', () => {
  let cusId: string;
  const prefix = `test-uro-${crypto.randomUUID().slice(0, 8)}`;

  // Org identifiers for each test
  const orgA = `${prefix}-a`;
  const orgB = `${prefix}-b`;
  const orgC = `${prefix}-c`;
  const orgD = `${prefix}-d`;

  // Subscription PKs — the org key is the only one the orchestrator scans.
  const pkA = `ORG#${orgA}`;
  const pkB = `ORG#${orgB}`;
  const pkC = `ORG#${orgC}`;
  const pkD = `ORG#${orgD}`;
  // A pre-re-key row the dated cleanup step has not removed yet. It names the
  // same org and is skipped, so orgD is still metered exactly once.
  const pkDLeftover = `CUSTOMER#${orgD}-legacy`;

  beforeAll(async () => {
    cusId = await createTestCustomer(prefix);

    // Test 1: Two orgs with subscriptions + profiles
    await seedSubscriptionRecord(pkA, orgA, cusId);
    await seedUserProfile(orgA, AURORA_TEST_TENANT_ID);

    await seedSubscriptionRecord(pkB, orgB, cusId);
    await seedUserProfile(orgB, AURORA_TEST_TENANT_ID);

    // Test 2: Org with subscription but NO profile
    await seedSubscriptionRecord(pkC, orgC, cusId);

    // Test 3: an org whose leftover CUSTOMER# row also claims it
    await seedSubscriptionRecord(pkD, orgD, cusId);
    await seedSubscriptionRecord(pkDLeftover, orgD, cusId);
    await seedUserProfile(orgD, AURORA_TEST_TENANT_ID);
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);

    // Clean up subscriptions
    await Promise.all([
      deleteSubscriptionRecord(pkA),
      deleteSubscriptionRecord(pkB),
      deleteSubscriptionRecord(pkC),
      deleteSubscriptionRecord(pkD),
      deleteSubscriptionRecord(pkDLeftover),
    ]);

    // Clean up profiles
    await Promise.all([deleteUserProfile(orgA), deleteUserProfile(orgB), deleteUserProfile(orgD)]);

    // Clean up audit records
    await Promise.all([
      deleteAuditRecord(orgA, reportDate),
      deleteAuditRecord(orgB, reportDate),
      deleteAuditRecord(orgC, reportDate),
      deleteAuditRecord(orgD, reportDate),
    ]);
  });

  it('processes seeded subscriptions — produces audit records', async () => {
    const result = await invokeOrchestrator();
    expect(result.functionError).toBeUndefined();

    // Poll for both audit records (orchestrator invokes workers async)
    const [auditA, auditB, auditD] = await Promise.all([
      pollForAuditRecord(orgA, reportDate),
      pollForAuditRecord(orgB, reportDate),
      pollForAuditRecord(orgD, reportDate),
    ]);

    const auditC = await getAuditRecord(orgC, reportDate);

    expect(auditA.orgId.S).toBe(orgA);
    expect(auditA.reportDate.S).toBe(reportDate);

    expect(auditB.orgId.S).toBe(orgB);
    expect(auditB.reportDate.S).toBe(reportDate);

    expect(auditC).toBeNull();

    // One audit record, so one worker invocation: the leftover CUSTOMER# row
    // was skipped at the scan rather than metered as a second org.
    expect(auditD.orgId.S).toBe(orgD);
    expect(auditD.reportDate.S).toBe(reportDate);
  });
});
