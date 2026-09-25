import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { getUsageLimits } from '@filone/shared';

import { useSidebarData } from './use-sidebar-data.js';

// Each query is dispatched by its queryKey; tests populate this map per case.
const queryData: { me?: unknown; billing?: unknown; usage?: unknown } = {};

vi.mock('../lib/query-client.js', () => ({
  queryKeys: { me: ['me'], billing: ['billing'], usage: ['usage'] },
  USAGE_STALE_TIME: 5 * 60_000,
  ME_STALE_TIME: 10 * 60_000,
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
    Inactive: 'inactive',
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

/**
 * A caller who holds `billing.view`. Every billing fact the sidebar derives is
 * read through the permission, so a case about one has to seed a caller who
 * may know it.
 */
const billingViewer = { permissions: ['billing.view'] };

/**
 * A caller who may read billing, and a plan for them to read. Usage meters need
 * both: `billing.view` is what makes the request, and the answer is what says
 * which limits apply.
 */
const billingReader = {
  me: billingViewer,
  billing: { subscription: { status: 'trialing' } },
};

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

    it('prefers name over email, taking both initials of a full name', () => {
      setQueries({ me: { name: 'Ada Lovelace', email: 'ada@example.com' } });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.displayName).toBe('Ada Lovelace');
      expect(result.current.initial).toBe('AL');
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
        me: billingViewer,
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
        me: billingViewer,
        billing: { subscription: { status: 'active', trialEndsAt: '2026-01-01' } },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.isTrialing).toBe(false);
      expect(result.current.trialDays).toBeNull();
      // label is derived purely from trialEndsAt, independent of status
      expect(result.current.trialEndsLabel).toBe('Expires Jan 1, 2026');
    });

    it('flags past-due subscriptions', () => {
      setQueries({ me: billingViewer, billing: { subscription: { status: 'past_due' } } });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.isPastDue).toBe(true);
    });

    it('flags inactive subscriptions (no entitlement)', () => {
      setQueries({ me: billingViewer, billing: { subscription: { status: 'inactive' } } });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.isInactive).toBe(true);
      expect(result.current.isTrialing).toBe(false);
      expect(result.current.isPastDue).toBe(false);
    });

    it('does not flag inactive while billing is still loading', () => {
      setQueries({});
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.isInactive).toBe(false);
    });

    it('computes graceDays + label when gracePeriodEndsAt is set', () => {
      setQueries({
        me: billingViewer,
        billing: { subscription: { status: 'grace_period', gracePeriodEndsAt: '2026-01-01' } },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.graceDays).toBe(5);
      expect(result.current.graceEndsLabel).toBe('Expires Jan 1, 2026');
    });

    it('drops every banner fact when billing becomes unreadable', () => {
      // A disabled query keeps its cached answer and a mounted sidebar keeps
      // reading it. After a demotion the "Payment failed" banner would still
      // render, with a /billing button the caller can no longer open.
      setQueries({
        me: { permissions: ['buckets.read'] },
        billing: {
          subscription: { status: 'past_due', gracePeriodEndsAt: '2026-01-01' },
        },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.isPastDue).toBe(false);
      expect(result.current.isInactive).toBe(false);
      expect(result.current.graceDays).toBeNull();
      expect(result.current.graceEndsLabel).toBeUndefined();
      expect(result.current.limitsKnown).toBe(false);
    });

    it('leaves grace/trial fields nullish when dates are absent', () => {
      setQueries({ me: billingViewer, billing: { subscription: { status: 'active' } } });
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
        ...billingReader,
        usage: { storage: { usedBytes: 250 }, egress: { usedBytes: 500 } },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.limitsKnown).toBe(true);
      expect(result.current.storagePct).toBe(25);
      expect(result.current.egressPct).toBe(50);
    });

    it('clamps percentages at 100 when usage exceeds the limit', () => {
      setQueries({
        ...billingReader,
        usage: { storage: { usedBytes: 5000 }, egress: { usedBytes: 9999 } },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.storagePct).toBe(100);
      expect(result.current.egressPct).toBe(100);
    });

    it('shows usage without a limit when billing is unreadable', () => {
      // A Member on pay-as-you-go was shown a meter filling toward the free
      // tier's 1 TB — a limit that is not theirs, derived from a plan the
      // console never read.
      setQueries({
        me: { permissions: ['buckets.read'] },
        usage: { storage: { usedBytes: 250 }, egress: { usedBytes: 500 } },
      });
      const { result } = renderHook(() => useSidebarData());
      expect(result.current.limitsKnown).toBe(false);
      expect(result.current.storageUsed).toBe(250);
      expect(result.current.storagePct).toBe(0);
      expect(result.current.egressPct).toBe(0);
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
