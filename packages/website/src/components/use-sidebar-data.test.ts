import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { getUsageLimits } from '@filone/shared';

import { useSidebarData } from './use-sidebar-data.js';

// Each query is dispatched by its queryKey; tests populate this map per case.
const queryData: { me?: unknown; billing?: unknown; usage?: unknown } = {};

vi.mock('../lib/query-client.js', () => ({
  queryKeys: { me: ['me'], billing: ['billing'], usage: ['usage'] },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryData[queryKey[0] as keyof typeof queryData],
  }),
}));

vi.mock('../lib/api.js', () => ({
  getMe: vi.fn(),
  getBilling: vi.fn(),
  getUsage: vi.fn(),
}));

vi.mock('../lib/time.js', () => ({
  daysUntil: vi.fn(() => 5),
  formatDateTime: vi.fn(() => 'Jan 1, 2026'),
}));

vi.mock('@filone/shared', () => ({
  SubscriptionStatus: {
    Trialing: 'trialing',
    PastDue: 'past_due',
    Active: 'active',
    GracePeriod: 'grace_period',
  },
  getUsageLimits: vi.fn(() => ({
    storageLimitBytes: 1000,
    egressLimitBytes: 1000,
  })),
}));

function setQueries(data: { me?: unknown; billing?: unknown; usage?: unknown }) {
  queryData.me = data.me;
  queryData.billing = data.billing;
  queryData.usage = data.usage;
}

describe('useSidebarData', () => {
  beforeEach(() => {
    setQueries({});
  });

  describe('displayName / initial', () => {
    it('falls back to "User" when no me data is present', () => {
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.displayName).toBe('User');
      expect(result.current.initial).toBe('U');
    });

    it('prefers name over email', () => {
      setQueries({ me: { name: 'Ada Lovelace', email: 'ada@example.com' } });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.displayName).toBe('Ada Lovelace');
      expect(result.current.initial).toBe('A');
    });

    it('uses email when name is absent', () => {
      setQueries({ me: { email: 'ada@example.com' } });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.displayName).toBe('ada@example.com');
      expect(result.current.initial).toBe('A');
    });
  });

  describe('subscription status flags', () => {
    it('flags trialing subscriptions and computes trialDays + label', () => {
      setQueries({
        billing: { subscription: { status: 'trialing', trialEndsAt: '2026-01-01' } },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.isTrialing).toBe(true);
      expect(result.current.isPastDue).toBe(false);
      expect(result.current.trialDays).toBe(5);
      expect(result.current.trialEndsLabel).toBe('Expires Jan 1, 2026');
    });

    it('does not compute trialDays when not trialing', () => {
      setQueries({
        billing: { subscription: { status: 'active', trialEndsAt: '2026-01-01' } },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.isTrialing).toBe(false);
      expect(result.current.trialDays).toBeNull();
      // label is derived purely from trialEndsAt, independent of status
      expect(result.current.trialEndsLabel).toBe('Expires Jan 1, 2026');
    });

    it('flags past-due subscriptions', () => {
      setQueries({ billing: { subscription: { status: 'past_due' } } });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.isPastDue).toBe(true);
    });

    it('computes graceDays + label when gracePeriodEndsAt is set', () => {
      setQueries({
        billing: { subscription: { status: 'grace_period', gracePeriodEndsAt: '2026-01-01' } },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.graceDays).toBe(5);
      expect(result.current.graceEndsLabel).toBe('Expires Jan 1, 2026');
    });

    it('leaves grace/trial fields nullish when dates are absent', () => {
      setQueries({ billing: { subscription: { status: 'active' } } });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.trialDays).toBeNull();
      expect(result.current.trialEndsLabel).toBeUndefined();
      expect(result.current.graceDays).toBeNull();
      expect(result.current.graceEndsLabel).toBeUndefined();
    });
  });

  describe('usage percentages', () => {
    it('defaults usage to 0 when no usage data is present', () => {
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.storageUsed).toBe(0);
      expect(result.current.storagePct).toBe(0);
      expect(result.current.egressUsed).toBe(0);
      expect(result.current.egressPct).toBe(0);
    });

    it('computes percentages against the limits', () => {
      setQueries({
        usage: { storage: { usedBytes: 250 }, egress: { usedBytes: 500 } },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.storagePct).toBe(25);
      expect(result.current.egressPct).toBe(50);
    });

    it('clamps percentages at 100 when usage exceeds the limit', () => {
      setQueries({
        usage: { storage: { usedBytes: 5000 }, egress: { usedBytes: 9999 } },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.storagePct).toBe(100);
      expect(result.current.egressPct).toBe(100);
    });

    it('avoids divide-by-zero, returning 0% when limits are 0', () => {
      vi.mocked(getUsageLimits).mockReturnValueOnce({
        storageLimitBytes: 0,
        egressLimitBytes: 0,
      });
      setQueries({
        usage: { storage: { usedBytes: 100 }, egress: { usedBytes: 100 } },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.storagePct).toBe(0);
      expect(result.current.egressPct).toBe(0);
    });
  });
});
