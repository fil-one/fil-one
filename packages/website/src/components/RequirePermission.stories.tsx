import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

import { RequirePermission } from './RequirePermission';
import { Button } from './Button';
import { seedPermissions } from '../lib/test-permissions.js';

/**
 * Each story gets its own QueryClient seeded with the role it is about.
 *
 * Built in `useState` rather than in the decorator body: a client constructed on
 * every render throws away the seeded cache each time React re-renders, and the
 * component under test flips back to its pending state mid-story.
 */
function withRole(role: OrgRole) {
  return function Decorator(Story: () => React.ReactElement) {
    const [client] = useState(() => {
      const created = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      seedPermissions(created, role);
      return created;
    });
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
