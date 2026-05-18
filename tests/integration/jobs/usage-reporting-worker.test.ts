import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createTestCustomer, getStripeClient } from '../helpers.js';
import {
  AURORA_TEST_TENANT_ID,
  invokeWorker,
  getAuditRecord,
  deleteAuditRecord,
} from './helpers.js';

const reportDate = new Date().toISOString().split('T')[0];

describe('Usage Reporting Worker (direct Lambda invoke)', () => {
  let cusId: string;
  const orgId = `test-urw-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    cusId = await createTestCustomer(orgId);
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteAuditRecord(orgId, reportDate);
  });

  it('paid subscription — writes audit record with lockAction skipped:paid', async () => {
    const result = await invokeWorker({
      orgId,
      auroraTenantId: AURORA_TEST_TENANT_ID,
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
      const result = await invokeWorker({
        orgId: trialOrgId,
        auroraTenantId: AURORA_TEST_TENANT_ID,
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
        lockAction: { S: 'ACTIVE' },
        orgSyncAction: { S: expect.any(String) },
        createdAt: { S: expect.any(String) },
        ttl: { N: expect.any(String) },
      });
    } finally {
      await deleteAuditRecord(trialOrgId, trialReportDate);
    }
  });

  it('syncs storage_used and organization_name to Stripe customer metadata', async () => {
    const syncOrgId = `test-urw-sync-${crypto.randomUUID().slice(0, 8)}`;
    const orgName = `Integration Test Org ${crypto.randomUUID().slice(0, 8)}`;

    try {
      const result = await invokeWorker({
        orgId: syncOrgId,
        auroraTenantId: AURORA_TEST_TENANT_ID,
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
      await deleteAuditRecord(syncOrgId, reportDate);
    }
  });

  it('non-existent tenant — returns Lambda error', async () => {
    const badOrgId = `test-urw-bad-${crypto.randomUUID().slice(0, 8)}`;

    const result = await invokeWorker({
      orgId: badOrgId,
      auroraTenantId: 'nonexistent-tenant-xxx',
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
  });
});
