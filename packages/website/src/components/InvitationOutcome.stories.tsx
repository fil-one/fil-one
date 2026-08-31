import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { ApiErrorCode, OrgRole } from '@filone/shared';

import { InvitationOutcome } from './InvitationOutcome';

/**
 * The panel lives off the router's root in the app, and one of its states
 * offers a router link, so the stories mount it the same way.
 */
function withRouter(Story: () => React.JSX.Element) {
  const rootRoute = createRootRoute();
  const acceptRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/invite/accept',
    component: Story,
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

/** An error shaped the way `apiRequest` throws one. */
function apiError(message: string, status: number, code?: string) {
  return Object.assign(new Error(message), { status, code });
}

const meta: Meta<typeof InvitationOutcome> = {
  title: 'Components/InvitationOutcome',
  component: InvitationOutcome,
  decorators: [(Story) => withRouter(Story)],
  args: {
    status: 'accepting',
    onContinue: () => {},
    onLogOut: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof InvitationOutcome>;

/** The token is being redeemed. */
export const Accepting: Story = {};

/** Joined. Continuing switches the tab into the new org and reloads. */
export const Accepted: Story = {
  args: {
    status: 'accepted',
    result: { orgId: 'org-9', orgName: 'Acme', role: OrgRole.Member, alreadyMember: false },
  },
};

/** Accepting twice is an idempotent success, not an error. */
export const AlreadyAMember: Story = {
  args: {
    status: 'accepted',
    result: { orgId: 'org-9', orgName: 'Acme', role: OrgRole.Admin, alreadyMember: true },
  },
};

/**
 * The token is good and the session is real, but they belong to two different
 * people — most often a forwarded invitation email.
 */
export const WrongAccount: Story = {
  args: {
    status: 'refused',
    sessionEmail: 'someone.else@example.com',
    error: apiError(
      'This invitation was sent to a different email address than the one you signed in with.',
      403,
      ApiErrorCode.INVITE_EMAIL_MISMATCH,
    ),
  },
};

/** An invitation is accepted by the address it was sent to, so it must be verified. */
export const EmailNotVerified: Story = {
  args: {
    status: 'refused',
    error: apiError('Email verification required', 403, ApiErrorCode.EMAIL_NOT_VERIFIED),
  },
};

/**
 * Expired, revoked, already accepted, and never existed share one answer: the
 * alternative would describe other people's invitations to whoever is holding a
 * stale link.
 */
export const NoLongerValid: Story = {
  args: {
    status: 'refused',
    error: apiError(
      'It may have expired or been revoked. Ask an administrator for a new invitation.',
      404,
      ApiErrorCode.INVITE_NOT_FOUND,
    ),
  },
};

/** A refusal with no state of its own renders the server's own sentence. */
export const InviterLostAuthority: Story = {
  args: {
    status: 'refused',
    error: apiError(
      'The person who invited you no longer has permission to add members. Ask an administrator for a new invitation.',
      403,
    ),
  },
};

/** The link was opened without a token, or this page load already spent it. */
export const NoToken: Story = {
  args: { status: 'no-token' },
};
