import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());

const mockTakeHourlyAllowance = vi.fn();
vi.mock('./hourly-allowance.ts', () => ({
  takeHourlyAllowance: (...args: unknown[]) => mockTakeHourlyAllowance(...args),
}));

import { takePromotionCodeCheck } from './promotion-code-rate-limit.ts';

describe('takePromotionCodeCheck', () => {
  beforeEach(() => mockTakeHourlyAllowance.mockReset());

  it("counts ten checks an hour on the org's row in OrgTable", async () => {
    const now = new Date('2026-11-09T12:00:00.000Z');
    mockTakeHourlyAllowance.mockResolvedValue({ allowed: true });

    expect(await takePromotionCodeCheck('any-org', now)).toStrictEqual({ allowed: true });
    expect(mockTakeHourlyAllowance).toHaveBeenCalledWith({
      tableName: 'OrgTable',
      key: { pk: { S: 'ORG#any-org' }, sk: { S: 'PROMOTION_CODE_CHECK_RATE' } },
      max: 10,
      now,
    });
  });
});
