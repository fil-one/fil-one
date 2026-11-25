import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

vi.mock('../plausible.js', () => ({ track: vi.fn() }));
vi.mock('../components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { Route as rootRoute } from './__root';
import { Route as appRoute } from './_app';
import { queryClient } from '../lib/query-client.js';

const me = {
  orgId: 'any-org',
  orgName: 'Any org',
  nameConfirmed: true,
  emailVerified: true,
  billingActive: true,
  role: 'owner',
  permissions: [],
};

/** Holds every `/me` request open until the returned function answers it. */
function holdMe(): () => void {
  let answer: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      await answered;
      return new Response(JSON.stringify(me), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return answer;
}

function renderApp() {
  const dashboardRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/dashboard',
    component: () => <div data-testid="dashboard" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute.addChildren([dashboardRoute])]),
    history: createMemoryHistory({ initialEntries: ['/dashboard'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('the console layout on a cold load', () => {
  beforeEach(() => {
    document.cookie = 'hs_logged_in=1';
  });

  afterEach(() => {
    queryClient.clear();
    vi.unstubAllGlobals();
    document.cookie = 'hs_logged_in=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  it('shows the shell placeholder while /me has not answered', async () => {
    holdMe();
    renderApp();

    expect(await screen.findByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
  });

  it('replaces the shell placeholder with the page once /me answers', async () => {
    const answer = holdMe();
    renderApp();
    await screen.findByRole('status', { name: 'Loading' });

    answer();

    expect(await screen.findByTestId('dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
  });
});
