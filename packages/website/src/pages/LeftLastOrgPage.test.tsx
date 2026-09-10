import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { LeftLastOrgPage } from './LeftLastOrgPage';

const mockLogout = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return { ...actual, logout: () => mockLogout() };
});

/**
 * The page mounted where it really lives: inside the router, off the root.
 * The "Create an organization" button renders a router link, so a bare
 * `render` would fail on the one action this page offers.
 */
function withRouter(email?: string) {
  const rootRoute = createRootRoute();
  const leftOrgRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/left-organization',
    component: () => <LeftLastOrgPage email={email} />,
  });
  const createOrgRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/create-organization',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([leftOrgRoute, createOrgRoute]),
    history: createMemoryHistory({ initialEntries: ['/left-organization'] }),
  });
  return <RouterProvider router={router} />;
}

describe('LeftLastOrgPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers creating a new organization as the primary path', async () => {
    render(withRouter());

    const link = await screen.findByRole('link', { name: 'Create an organization' });
    expect(link).toHaveAttribute('href', '/create-organization');
  });

  it('offers deleting the account instead, pointed at support', async () => {
    render(withRouter());

    const link = await screen.findByRole('link', { name: 'support@fil.one' });
    expect(link).toHaveAttribute('href', 'mailto:support@fil.one');
  });

  it('names the signed-in account when given one', async () => {
    render(withRouter('ada@example.com'));

    expect(await screen.findByText(/Signed in as/)).toHaveTextContent('ada@example.com');
  });

  it('signs out from the footer, the same escape hatch WelcomePage offers', async () => {
    render(withRouter('ada@example.com'));

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(mockLogout).toHaveBeenCalled();
  });

  it('has no account to name, and no sign-out escape hatch, before /me resolves', () => {
    render(withRouter());

    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });
});
