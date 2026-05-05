import { describe, it, expect } from 'vitest';
import { invokeDriftChecker } from './helpers.ts';

// The drift checker is observe-only: it scans, probes Aurora, and emits metrics.
// There is no DynamoDB side-effect to assert on, so these tests assert the
// Lambda runs cleanly and the run-summary metric line shows up in the log tail.

describe('subscription-drift-checker — active sub + non-existent Aurora tenant', () => {
  it('runs without error and emits a run-summary metric', async () => {
    const result = await invokeDriftChecker();

    expect(result.functionError).toBeUndefined();
    expect(result.logTail).toBeDefined();
    // The summary emission is a structured log line containing all three counters.
    expect(result.logTail!).toContain('SubscriptionsNotInSync');
    expect(result.logTail!).toContain('SubscriptionsMissingTenant');
    expect(result.logTail!).toContain('SubscriptionsProbeFailed');
  });
});
