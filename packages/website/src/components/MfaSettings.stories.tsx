import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { OrgRole, ROLE_PERMISSIONS } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { Card } from './Card';
import { MfaSettings } from './MfaSettings';

const me: MeResponse = {
  orgId: 'org-1',
  orgName: 'Acme',
  nameConfirmed: true,
  emailVerified: true,
  email: 'user@example.com',
  name: 'Ada',
  connectionType: 'auth0',
  mfaEnrollments: [],
  passkeys: [],
  orgsBeta: true,
  billingActive: true,
  ragAccess: false,
  userId: 'user-1',
  role: OrgRole.Owner,
  permissions: ROLE_PERMISSIONS[OrgRole.Owner],
};

const biometrics = {
  id: 'any-biometrics',
  type: 'webauthn-platform',
  name: "Ada's Mac",
  createdAt: '2026-09-04T10:00:00Z',
} as const;

const authenticator = {
  id: 'any-authenticator',
  type: 'authenticator',
  createdAt: '2026-10-12T10:00:00Z',
} as const;

/** Laid out the way Settings' Security card lays it out. */
function withSecurityCard(Story: () => React.JSX.Element) {
  // The component reads the URL to resume a step-up redirect.
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <Card padding="none" className="max-w-2xl">
          <div className="flex flex-col gap-3 px-5 pt-4 pb-4">
            <Story />
          </div>
        </Card>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  });
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof MfaSettings> = {
  title: 'Components/MfaSettings',
  component: MfaSettings,
  decorators: [(Story) => withSecurityCard(() => <Story />)],
};

export default meta;
type Story = StoryObj<typeof MfaSettings>;

export const NotEnrolled: Story = { args: { me } };

/** One method: its own Remove turns two-factor off, so there is no Remove all. */
export const OneMethod: Story = { args: { me: { ...me, mfaEnrollments: [biometrics] } } };

export const SeveralMethods: Story = {
  args: { me: { ...me, mfaEnrollments: [biometrics, authenticator] } },
};

export const WithPasskeys: Story = {
  args: {
    me: {
      ...me,
      mfaEnrollments: [biometrics],
      passkeys: [{ id: 'any-passkey', name: 'iCloud Keychain', createdAt: '2026-08-15T10:00:00Z' }],
    },
  },
};
