import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { ApiErrorCode, OrgRole } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { AcceptInvitationPage } from './AcceptInvitationPage.js';

// ---------------------------------------------------------------------------
// Mocks — API client boundary
// ---------------------------------------------------------------------------

const mockAccept = vi.fn();
const mockSwitchToOrg = vi.fn();
const mockLogout = vi.fn();

vi.mock('../lib/members-api.js', () => ({
  acceptInvitation: (...args: unknown[]) => mockAccept(...args),
}));

vi.mock('../lib/active-org.js', () => ({
  switchToOrg: (...args: unknown[]) => mockSwitchToOrg(...args),
}));

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return { ...actual, getMe: vi.fn(), logout: () => mockLogout() };
});

const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * The page mounted where it really lives: inside the router, off the root
 * rather than the app layout. The console's `Link` renders a router link, so a
 * bare `render` would fail on the one state that offers a way out.
 */
function withRouter(token: string | null) {
  const rootRoute = createRootRoute();
  const acceptRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/invite/accept',
    component: () => <AcceptInvitationPage token={token} />,
  });
  const verifyEmailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/verify-email',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([acceptRoute, verifyEmailRoute]),
    history: createMemoryHistory({ initialEntries: ['/invite/accept'] }),
  });
  return <RouterProvider router={router} />;
}

function renderPage(token: string | null = TOKEN) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // `/me` is seeded rather than fetched: the page reads it only to name the
  // address this session carries, and only when the invitation names another.
  seedPermissions(client, OrgRole.Member, { email: 'wrong@example.com' });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{withRouter(token)}</ToastProvider>
    </QueryClientProvider>,
  );
}

/** An error shaped the way `apiRequest` throws one. */
function apiError(message: string, status: number, code?: string): Error {
  return Object.assign(new Error(message), { status, code });
}

describe('AcceptInvitationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says the link is no longer valid when there is no token to redeem', async () => {
    renderPage(null);

    expect(await screen.findByTestId('accept-no-token')).toBeInTheDocument();
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('redeems the token exactly once', async () => {
    mockAccept.mockResolvedValue({
      orgId: 'org-9',
      orgName: 'Acme',
      role: OrgRole.Member,
      alreadyMember: false,
    });
    renderPage();

    await waitFor(() => expect(mockAccept).toHaveBeenCalledWith(TOKEN));

    // A token is single-use, and the page renders more than once on its way
    // through the state machine: a second attempt would spend the invitation
    // the first one is still redeeming.
    await screen.findByTestId('accept-success');
    expect(mockAccept).toHaveBeenCalledTimes(1);
  });

  it('names the org, and switches into it on the way out', async () => {
    mockAccept.mockResolvedValue({
      orgId: 'org-9',
      orgName: 'Acme',
      role: OrgRole.Admin,
      alreadyMember: false,
    });
    renderPage();

    const panel = await screen.findByTestId('accept-success');
    expect(panel).toHaveTextContent('You have joined Acme');
    expect(panel).toHaveTextContent('Your role in Acme is Admin');

    fireEvent.click(screen.getByRole('button', { name: 'Continue to Acme' }));
    expect(mockSwitchToOrg).toHaveBeenCalledWith('org-9');
  });

  it('treats a second acceptance as the success it is', async () => {
    mockAccept.mockResolvedValue({
      orgId: 'org-9',
      orgName: 'Acme',
      role: OrgRole.Member,
      alreadyMember: true,
    });
    renderPage();

    expect(await screen.findByTestId('accept-success')).toHaveTextContent(
      'You are already in Acme',
    );
  });

  it('says which account is signed in when the invitation names another', async () => {
    mockAccept.mockRejectedValue(
      apiError(
        'This invitation was sent to a different email address than the one you signed in with.',
        403,
        ApiErrorCode.INVITE_EMAIL_MISMATCH,
      ),
    );
    renderPage();

    const panel = await screen.findByTestId('accept-mismatch');
    expect(panel).toHaveTextContent('You are signed in as wrong@example.com');
    expect(panel).toHaveTextContent('names another address');

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(mockLogout).toHaveBeenCalled();
  });

  it('points an unverified account at the verify-email surface', async () => {
    mockAccept.mockRejectedValue(
      apiError('Email verification required', 403, ApiErrorCode.EMAIL_NOT_VERIFIED),
    );
    renderPage();

    const panel = await screen.findByTestId('accept-unverified');
    expect(panel).toHaveTextContent('Verify your email address first');
    expect(screen.getByRole('link', { name: 'Verify your email' })).toHaveAttribute(
      'href',
      '/verify-email',
    );
  });

  it('gives one answer for expired, revoked, and never-existed alike', async () => {
    mockAccept.mockRejectedValue(
      apiError(
        'That invitation is no longer valid. Ask for a new one.',
        404,
        ApiErrorCode.INVITE_NOT_FOUND,
      ),
    );
    renderPage();

    const panel = await screen.findByTestId('accept-invalid');
    expect(panel).toHaveTextContent('This invitation is no longer valid');
    expect(panel).toHaveTextContent('Ask for a new one.');
  });

  it('renders the server’s sentence for a refusal it has no state for', async () => {
    mockAccept.mockRejectedValue(
      apiError(
        'The person who invited you no longer has permission to add members. Ask an administrator for a new invitation.',
        403,
      ),
    );
    renderPage();

    expect(await screen.findByTestId('accept-failed')).toHaveTextContent(
      'no longer has permission to add members',
    );
  });

  it('waits while the invitation is being redeemed', async () => {
    mockAccept.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(await screen.findByTestId('accept-pending')).toBeInTheDocument();
  });
});
