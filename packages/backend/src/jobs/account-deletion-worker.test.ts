import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunAccountDeletion = vi.fn();
vi.mock('../lib/account-deletion.js', () => ({
  runAccountDeletion: (...args: unknown[]) => mockRunAccountDeletion(...args),
}));

import { handler, type AccountDeletionWorkerPayload } from './account-deletion-worker.js';

describe('account-deletion-worker handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drives the teardown for the payload orgId', async () => {
    mockRunAccountDeletion.mockResolvedValue(undefined);

    await handler({ orgId: 'org-1' });

    expect(mockRunAccountDeletion).toHaveBeenCalledWith('org-1', { resweep: false });
  });

  it('forwards the resweep flag, which is what gets the pass past the DONE early-return', async () => {
    mockRunAccountDeletion.mockResolvedValue(undefined);

    await handler({ orgId: 'org-1', resweep: true });

    expect(mockRunAccountDeletion).toHaveBeenCalledWith('org-1', { resweep: true });
  });

  it('throws on a payload without orgId so the async invoke fails loudly (retry/DLQ visibility)', async () => {
    await expect(handler({} as AccountDeletionWorkerPayload)).rejects.toThrow(/Missing orgId/);

    expect(mockRunAccountDeletion).not.toHaveBeenCalled();
  });

  it('propagates teardown failures so the Lambda async retry / orchestrator re-drives', async () => {
    mockRunAccountDeletion.mockRejectedValue(new Error('stripe is down'));

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(handler({ orgId: 'org-1' })).rejects.toThrow('stripe is down');

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('a healthy pass emits no Lambda Errors datapoint, even though it waits on Stripe', async () => {
    // The wait for Stripe's search-index lag happens IN-PASS (see
    // stripeSearchLagRemaining). If it were deferred by throwing, every healthy
    // deletion would produce an `Errors` datapoint — the metric the Grafana
    // MetricStream alerts on — and burn an async retry per teardown.
    mockRunAccountDeletion.mockResolvedValue(undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handler({ orgId: 'org-1' });

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
