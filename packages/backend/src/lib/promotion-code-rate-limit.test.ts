import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());

const mockRecordRateLimitedRequest = vi.fn();
vi.mock('./rate-limit.ts', () => ({
  recordRateLimitedRequest: (...args: unknown[]) => mockRecordRateLimitedRequest(...args),
}));

import { takePromotionCodeCheck } from './promotion-code-rate-limit.ts';

describe('takePromotionCodeCheck', () => {
  beforeEach(() => mockRecordRateLimitedRequest.mockReset());

  it("counts ten checks an hour on the org's row in OrgTable", async () => {
    const now = new Date('2026-11-09T12:00:00.000Z');
    mockRecordRateLimitedRequest.mockResolvedValue({ allowed: true });

    expect(await takePromotionCodeCheck('any-org', now)).toStrictEqual({ allowed: true });
    expect(mockRecordRateLimitedRequest).toHaveBeenCalledWith({
      tableName: 'OrgTable',
      key: { pk: { S: 'ORG#any-org' }, sk: { S: 'PROMOTION_CODE_CHECK_RATE' } },
      max: 10,
      now,
    });
  });
});
