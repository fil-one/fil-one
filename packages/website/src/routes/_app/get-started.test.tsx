import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type OnboardingProps = { hasBucket: boolean; hasKey: boolean; mayInvite: boolean };

const { onboardingProps } = vi.hoisted(() => ({
  onboardingProps: { current: undefined as undefined | OnboardingProps },
}));

vi.mock('../_app.js', () => ({ Route: {} }));
vi.mock('../../pages/OnboardingPage.js', () => ({
  OnboardingPage: (props: OnboardingProps) => {
    onboardingProps.current = props;
    return null;
  },
}));
vi.mock('../../lib/api.js', () => ({ getUsage: vi.fn() }));
vi.mock('../../lib/use-member-scope.js', () => ({
  useMemberActionScope: () => ({ mayInvite: true }),
}));

import { Route } from './get-started';
import { getUsage } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-client.js';

function usage(buckets: number, accessKeys: number) {
  return { buckets: { count: buckets }, accessKeys: { count: accessKeys } } as never;
}

function renderRoute() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Component = Route.options.component as React.ComponentType;
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  return client;
}

describe('the get-started route', () => {
  beforeEach(() => {
    vi.mocked(getUsage).mockReset();
    onboardingProps.current = undefined;
  });

  it('shows no task done before usage has loaded', () => {
    vi.mocked(getUsage).mockReturnValue(new Promise(() => {}));
    renderRoute();

    expect(onboardingProps.current).toEqual({ hasBucket: false, hasKey: false, mayInvite: true });
  });

  it('ticks the bucket and key tasks from usage', async () => {
    vi.mocked(getUsage).mockResolvedValue(usage(1, 0));
    renderRoute();

    await waitFor(() =>
      expect(onboardingProps.current).toEqual({ hasBucket: true, hasKey: false, mayInvite: true }),
    );
  });

  // A bucket or key made from a terminal ticks its task without a reload.
  it('polls usage every 5 seconds while the page is open', () => {
    vi.mocked(getUsage).mockReturnValue(new Promise(() => {}));
    const client = renderRoute();

    const [observer] = client.getQueryCache().find({ queryKey: queryKeys.usage })!.observers;
    expect(observer.options.refetchInterval).toBe(5000);
  });
});
