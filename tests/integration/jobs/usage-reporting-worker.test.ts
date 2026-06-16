import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createTestCustomer, getStripeClient } from '../helpers.js';
import {
  AURORA_TEST_TENANT_ID,
  invokeWorker,
  getAuditRecord,
  deleteAuditRecord,
  seedUserProfile,
  deleteUserProfile,
} from './helpers.js';

const reportDate = new Date().toISOString().split('T')[0];

describe('Usage Reporting Worker (direct Lambda invoke)', () => {
  let cusId: string;
  const orgId = `test-urw-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    cusId = await createTestCustomer(orgId);
    // The worker discovers provisioned regions via isTenantReady, which reads
    // the org PROFILE. Seed one pointing at the known Aurora test tenant.
    await seedUserProfile(orgId, AURORA_TEST_TENANT_ID);
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteUserProfile(orgId);
    await deleteAuditRecord(orgId, reportDate);
  });

  it('paid subscription — writes audit record with lockAction skipped:paid', async () => {
    const result = await invokeWorker({
      orgId,
      subscriptionId: 'sub_test_paid',
      stripeCustomerId: cusId,
      currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      subscriptionStatus: 'active',
      reportDate,
    });

    expect(result.functionError).toBeUndefined();

    const audit = await getAuditRecord(orgId, reportDate);
    expect(audit).toStrictEqual({
      pk: { S: `ORG#${orgId}` },
      sk: { S: `USAGE_REPORT#${reportDate}` },
      orgId: { S: orgId },
      subscriptionId: { S: 'sub_test_paid' },
      stripeCustomerId: { S: cusId },
      currentPeriodStart: { S: expect.any(String) },
      subscriptionStatus: { S: 'active' },
      reportDate: { S: reportDate },
      averageStorageBytesUsed: { N: expect.any(String) },
      averageStorageGbUsed: { N: expect.any(String) },
      totalEgressBytes: { N: expect.any(String) },
      sampleCount: { N: expect.any(String) },
      reportedToStripe: { BOOL: true },
      lockAction: { S: 'skipped:paid' },
      orgSyncAction: { S: expect.any(String) },
      createdAt: { S: expect.any(String) },
      ttl: { N: expect.any(String) },
    });
  });

  it('trial subscription — enforces limits check', async () => {
    const trialOrgId = `test-urw-trial-${crypto.randomUUID().slice(0, 8)}`;
    const trialReportDate = reportDate;

    try {
      await seedUserProfile(trialOrgId, AURORA_TEST_TENANT_ID);
      const result = await invokeWorker({
        orgId: trialOrgId,
        subscriptionId: 'sub_test_trial',
        stripeCustomerId: cusId,
        currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        subscriptionStatus: 'trialing',
        reportDate: trialReportDate,
      });

      expect(result.functionError).toBeUndefined();

      const audit = await getAuditRecord(trialOrgId, trialReportDate);
      expect(audit).toStrictEqual({
        pk: { S: `ORG#${trialOrgId}` },
        sk: { S: `USAGE_REPORT#${trialReportDate}` },
        orgId: { S: trialOrgId },
        subscriptionId: { S: 'sub_test_trial' },
        stripeCustomerId: { S: cusId },
        currentPeriodStart: { S: expect.any(String) },
        subscriptionStatus: { S: 'trialing' },
        reportDate: { S: trialReportDate },
        averageStorageBytesUsed: { N: expect.any(String) },
        averageStorageGbUsed: { N: expect.any(String) },
        totalEgressBytes: { N: expect.any(String) },
        sampleCount: { N: expect.any(String) },
        reportedToStripe: { BOOL: expect.any(Boolean) },
        lockAction: { S: 'active' },
        orgSyncAction: { S: expect.any(String) },
        createdAt: { S: expect.any(String) },
        ttl: { N: expect.any(String) },
      });
    } finally {
      await deleteUserProfile(trialOrgId);
      await deleteAuditRecord(trialOrgId, trialReportDate);
    }
  });

  it('syncs storage_used and organization_name to Stripe customer metadata', async () => {
    const syncOrgId = `test-urw-sync-${crypto.randomUUID().slice(0, 8)}`;
    const orgName = `Integration Test Org ${crypto.randomUUID().slice(0, 8)}`;

    try {
      await seedUserProfile(syncOrgId, AURORA_TEST_TENANT_ID);
      const result = await invokeWorker({
        orgId: syncOrgId,
        orgName,
        subscriptionId: 'sub_test_sync',
        stripeCustomerId: cusId,
        currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        subscriptionStatus: 'active',
        reportDate,
      });

      expect(result.functionError).toBeUndefined();

      const customer = await getStripeClient().customers.retrieve(cusId);
      if (customer.deleted) throw new Error('Customer was unexpectedly deleted');
      expect(customer.metadata).toEqual({
        orgId: expect.any(String),
        userId: expect.any(String),
        organization_name: orgName,
        storage_used: expect.stringMatching(/^\d+(\.\d+)? (B|KB|MB|GB|TB)$/),
      });

      const audit = await getAuditRecord(syncOrgId, reportDate);
      expect(audit?.orgSyncAction).toStrictEqual({ S: 'ok' });
    } finally {
      await deleteUserProfile(syncOrgId);
      await deleteAuditRecord(syncOrgId, reportDate);
    }
  });

  it('non-existent tenant — returns Lambda error', async () => {
    const badOrgId = `test-urw-bad-${crypto.randomUUID().slice(0, 8)}`;

    try {
      // Seed a profile so the org resolves as provisioned, but point it at a
      // tenant that doesn't exist in Aurora. The worker reaches the metrics
      // fetch, which throws, surfacing a Lambda error.
      await seedUserProfile(badOrgId, 'nonexistent-tenant-xxx');

      const result = await invokeWorker({
        orgId: badOrgId,
        subscriptionId: 'sub_test_bad',
        stripeCustomerId: cusId,
        currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        subscriptionStatus: 'active',
        reportDate,
      });

      expect(result.functionError).toBeDefined();

      // No audit record should be written on failure
      const audit = await getAuditRecord(badOrgId, reportDate);
      expect(audit).toBeNull();
    } finally {
      await deleteUserProfile(badOrgId);
      await deleteAuditRecord(badOrgId, reportDate);
    }
  });
});
