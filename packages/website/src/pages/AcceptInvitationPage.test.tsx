import { StrictMode } from 'react';
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
import { hasPendingInviteToken } from '../lib/invite-token.js';
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

/**
 * Rendered in `StrictMode`, which is how the app runs in development: effects
 * fire twice, and the token this page spends is single-use. Anything that
 * redeems once has to be shown doing so under the double invocation it guards
 * against.
 */
function renderPage(token: string | null = TOKEN) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // `/me` is seeded rather than fetched: the page reads it only to name the
  // address this session carries, and only when the invitation names another.
  seedPermissions(client, OrgRole.Member, { email: 'wrong@example.com' });
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <ToastProvider>{withRouter(token)}</ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
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
      slug: 'acme',
      role: OrgRole.Admin,
      alreadyMember: false,
    });
    renderPage();

    const panel = await screen.findByTestId('accept-success');
    expect(panel).toHaveTextContent('Welcome to Acme');
    expect(panel).toHaveTextContent('Admin');

    fireEvent.click(screen.getByRole('button', { name: 'Continue to Acme' }));
    // The slug rides along: this org was never in any cache before this
    // moment, so switchToOrg has to be told directly rather than resolving
    // it from `/me`, which would find nothing and fall back to the unscoped
    // `/dashboard`.
    expect(mockSwitchToOrg).toHaveBeenCalledWith('org-9', 'acme');
  });

  it('treats a second acceptance as the success it is', async () => {
    mockAccept.mockResolvedValue({
      orgId: 'org-9',
      orgName: 'Acme',
      role: OrgRole.Member,
      alreadyMember: true,
    });
    renderPage();

    expect(await screen.findByTestId('accept-success')).toHaveTextContent("You're already in Acme");
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
    expect(panel).toHaveTextContent('You’re signed in as wrong@example.com');
    expect(panel).toHaveTextContent('sign in with the right address');

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
        'It may have expired or been revoked. Ask an administrator for a new invitation.',
        404,
        ApiErrorCode.INVITE_NOT_FOUND,
      ),
    );
    renderPage();

    const panel = await screen.findByTestId('accept-invalid');
    expect(panel).toHaveTextContent('This invitation is no longer valid');
    expect(panel).toHaveTextContent('Ask an administrator for a new invitation.');
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

  it('announces the outcome and moves to it', async () => {
    mockAccept.mockResolvedValue({
      orgId: 'org-9',
      orgName: 'Acme',
      role: OrgRole.Member,
      alreadyMember: false,
    });
    renderPage();

    const panel = await screen.findByTestId('accept-success');
    // The wait and the answer are one panel replaced by another, so a caller
    // not watching the page has to be told the swap happened and taken to it.
    expect(panel.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Welcome to Acme' })).toHaveFocus(),
    );
  });

  it('puts the token back when the accept lands on the login funnel', async () => {
    sessionStorage.clear();
    mockAccept.mockRejectedValue(apiError('Session expired. Redirecting to login...', 401));
    renderPage();

    // The route took the token out of storage before this call went out, so a
    // 401 would otherwise spend the trip through Auth0 and land on the
    // dashboard with nothing left to redeem.
    await waitFor(() => expect(hasPendingInviteToken()).toBe(true));
  });

  it('puts the token back when the account needs email verification first', async () => {
    sessionStorage.clear();
    mockAccept.mockRejectedValue(
      apiError('Email verification required', 403, ApiErrorCode.EMAIL_NOT_VERIFIED),
    );
    renderPage();

    // Otherwise the detour through /verify-email lands on the dashboard with
    // nothing left to redeem, the same loss a 401 bounce would leave behind.
    await waitFor(() => expect(hasPendingInviteToken()).toBe(true));
  });

  it('reads /me without the reconciliation that would reload the page', async () => {
    mockAccept.mockRejectedValue(
      apiError('Sent to another address', 403, ApiErrorCode.INVITE_EMAIL_MISMATCH),
    );
    const { getMe } = await import('../lib/api.js');
    vi.mocked(getMe).mockResolvedValue({ email: 'invitee@example.com' } as never);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>{withRouter(TOKEN)}</ToastProvider>
      </QueryClientProvider>,
    );

    // The reload the reconcile performs would destroy the token this page is
    // holding, and the org it is joining is not the org the stash is about.
    await waitFor(() => expect(getMe).toHaveBeenCalledWith({ skipOrgReconcile: true }));
  });

  it('does not put /me in flight beside the accept it explains', async () => {
    sessionStorage.clear();
    let refuse: (error: unknown) => void = () => {};
    mockAccept.mockReturnValue(new Promise((_resolve, reject) => (refuse = reject)));
    const { getMe } = await import('../lib/api.js');
    // Both calls answer 401 over an expired session, and whichever lands first
    // starts the navigation to login. If /me were in flight it could get there
    // first, the unload would cancel the accept, and the rejection would arrive
    // as a TypeError carrying no status — so the re-stash below would not run.
    vi.mocked(getMe).mockRejectedValue(apiError('Session expired', 401));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>{withRouter(TOKEN)}</ToastProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(mockAccept).toHaveBeenCalledWith(TOKEN));
    expect(getMe).not.toHaveBeenCalled();

    refuse(apiError('Session expired. Redirecting to login...', 401));
    await waitFor(() => expect(hasPendingInviteToken()).toBe(true));
  });
});
