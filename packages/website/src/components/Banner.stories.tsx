import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { Banner, type BannerVariant } from './Banner';

function withRouter(Story: React.ComponentType) {
  const rootRoute = createRootRoute({ component: () => <Story /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof Banner> = {
  title: 'Components/Banner',
  component: Banner,
  decorators: [withRouter],
  parameters: {
    layout: 'fullscreen',
  },
  argTypes: {
    variant: { control: 'select', options: ['error', 'warning', 'info'] },
  },
};

export default meta;
type Story = StoryObj<typeof Banner>;

export const Error: Story = {
  args: {
    variant: 'error',
    children:
      'Egress limit exceeded. Your account has been temporarily disabled. Upgrade to restore access.',
    action: { label: 'Upgrade', href: '/billing' },
  },
};

export const Info: Story = {
  args: {
    variant: 'info',
    children: 'A new version is available. Refresh to get the latest experience.',
    action: { label: 'Refresh', onClick: () => {} },
  },
};

export const Warning: Story = {
  args: {
    variant: 'warning',
    children: 'Storage limit exceeded. Uploads are disabled. Delete files or upgrade to resume.',
    action: { label: 'Upgrade', href: '/billing' },
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col">
      {(['error', 'warning', 'info'] as BannerVariant[]).map((variant) => (
        <Banner key={variant} variant={variant} action={{ label: 'Action', href: '#' }}>
          This is a <strong>{variant}</strong> banner message spanning the full width.
        </Banner>
      ))}
    </div>
  ),
};
