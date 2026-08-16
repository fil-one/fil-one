import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

import { RequirePermission } from './RequirePermission';
import { Button } from './Button';
import { seedPermissions } from '../lib/test-permissions.js';

/**
 * Each story gets its own QueryClient seeded with the role it is about — the
 * preview's shared client would otherwise carry one story's role into the next.
 */
function withRole(role: OrgRole) {
  return function Decorator(Story: () => React.ReactElement) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedPermissions(client, role);
    return (
      <QueryClientProvider client={client}>
        <Story />
      </QueryClientProvider>
    );
  };
}

const meta: Meta<typeof RequirePermission> = {
  title: 'Components/RequirePermission',
  component: RequirePermission,
  args: {
    permission: 'buckets.delete',
    children: <Button variant="destructive">Delete bucket</Button>,
  },
};

export default meta;
type Story = StoryObj<typeof RequirePermission>;

/** An Admin holds `buckets.delete`, so the control renders. */
export const Allowed: Story = {
  decorators: [withRole(OrgRole.Admin)],
};

/** A Member does not, and nothing takes its place. */
export const Denied: Story = {
  decorators: [withRole(OrgRole.Member)],
};

/** A page-sized surface says why instead of leaving a hole. */
export const DeniedWithFallback: Story = {
  args: {
    permission: 'billing.manage',
    fallback: (
      <p className="text-sm text-zinc-600">
        Billing is managed by your organization&rsquo;s owners.
      </p>
    ),
  },
  decorators: [withRole(OrgRole.ReadOnly)],
};
