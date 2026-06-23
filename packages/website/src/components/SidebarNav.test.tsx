import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import type { MeResponse } from '@filone/shared';

import { queryKeys } from '../lib/query-client.js';
import { SidebarNav } from './SidebarNav.js';

// The instatus summary query fires on mount; stub the network call so the test
// exercises nav rendering without a real fetch.
vi.mock('../lib/instatus.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/instatus.js')>('../lib/instatus.js');
  return { ...actual, fetchInstatusSummary: vi.fn(async () => null) };
});

const NAV_PATHS = [
  '/dashboard',
  '/buckets',
  '/api-keys',
  '/billing',
  '/settings',
  '/support',
  '/bucket-intelligence',
  '/ai-agent-toolkit',
  '/rag-pipeline',
];

function me(ragAccess: boolean): MeResponse {
  return {
    orgId: 'org-1',
    orgName: 'Acme',
    emailVerified: true,
    email: 'user@example.com',
    name: 'User',
    mfaEnrollments: [],
    ragAccess,
  };
}

function renderSidebar(ragAccess: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.me, me(ragAccess));

  const rootRoute = createRootRoute({
    component: () => <SidebarNav collapsed={false} onToggle={vi.fn()} />,
  });
  const routes = NAV_PATHS.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ['/dashboard'] }),
  });

  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('SidebarNav RAG Pipeline gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the RAG Pipeline nav item for users with RAG access', async () => {
    renderSidebar(true);

    const item = await screen.findByTestId('nav-rag-pipeline');
    expect(item).toBeInTheDocument();
    expect(item).toHaveAttribute('href', '/rag-pipeline');
    expect(item).toHaveTextContent('RAG Pipeline');
  });

  it('hides the RAG Pipeline nav item for users without RAG access', async () => {
    renderSidebar(false);

    // The AI Tools group still renders so we can assert the gate is specific.
    expect(await screen.findByTestId('nav-ai-agent-toolkit')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-rag-pipeline')).not.toBeInTheDocument();
  });
});
