import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SubscriptionStatus } from '@filone/shared';
import { seedBillingRecord, deleteBillingRecord } from '../helpers.ts';
import { invokeDriftChecker, seedOrgProfile, deleteOrgProfile } from './helpers.ts';

// The drift checker is observe-only: it scans, probes Aurora, and emits metrics.
// There is no DynamoDB side-effect to assert on, so these tests assert the
// Lambda runs cleanly and the run-summary metric line shows up in the log tail.

describe('subscription-drift-checker — active sub + non-existent Aurora tenant', () => {
  const userId = `drift-missing-${crypto.randomUUID().slice(0, 8)}`;
  const orgId = `org-drift-missing-${crypto.randomUUID().slice(0, 8)}`;
  // A tenant id that is syntactically valid but does not exist in Aurora.
  const nonExistentTenantId = crypto.randomUUID();

  beforeAll(async () => {
    await seedOrgProfile(orgId, nonExistentTenantId);
    await seedBillingRecord(userId, 'cus_fake_drift', SubscriptionStatus.Active, {
      orgId: { S: orgId },
    });
  });

  afterAll(async () => {
    await deleteBillingRecord(userId);
    await deleteOrgProfile(orgId);
  });

  it('runs without error and emits a run-summary metric', async () => {
    const result = await invokeDriftChecker();

    expect(result.functionError).toBeUndefined();
    // The summary emission is a structured log line containing this key.
    expect(result.logTail).toContain('SubscriptionDriftCheckScanned');
  });
});
