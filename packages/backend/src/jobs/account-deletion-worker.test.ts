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

    expect(mockRunAccountDeletion).toHaveBeenCalledWith('org-1');
  });

  it('throws on a payload without orgId so the async invoke fails loudly (retry/DLQ visibility)', async () => {
    await expect(handler({} as AccountDeletionWorkerPayload)).rejects.toThrow(/Missing orgId/);

    expect(mockRunAccountDeletion).not.toHaveBeenCalled();
  });

  it('propagates teardown failures so the Lambda async retry / orchestrator re-drives', async () => {
    mockRunAccountDeletion.mockRejectedValue(new Error('stripe is down'));

    await expect(handler({ orgId: 'org-1' })).rejects.toThrow('stripe is down');
  });
});
