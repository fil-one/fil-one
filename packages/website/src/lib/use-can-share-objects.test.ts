import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { SubscriptionStatus } from '@filone/shared';

import { useCanShareObjects } from './use-can-share-objects.js';

let billingStatus: SubscriptionStatus | undefined;

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: billingStatus ? { subscription: { status: billingStatus } } : undefined,
  }),
}));

vi.mock('./use-permissions.js', () => ({
  useHasPermission: () => true,
}));

vi.mock('./api.js', () => ({ getBilling: vi.fn() }));

vi.mock('./query-client.js', () => ({ queryKeys: { billing: ['billing'] } }));

describe('useCanShareObjects', () => {
  it.each([
    [SubscriptionStatus.Active, true],
    [SubscriptionStatus.Manual, true],
    [SubscriptionStatus.Trialing, false],
  ])('offers share links to an org whose status is %s: %s', (status, expected) => {
    billingStatus = status;

    const { result } = renderHook(() => useCanShareObjects());

    expect(result.current).toBe(expected);
  });
});
