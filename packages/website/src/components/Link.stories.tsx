import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';

import { Link } from './Link';

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute(),
});

const meta: Meta<typeof Link> = {
  title: 'Components/Link',
  component: Link,
  decorators: [(Story) => <RouterProvider router={router} defaultComponent={() => <Story />} />],
  args: {
    href: '/buckets',
    children: 'View all buckets',
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['subtle', 'accent'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Link>;

export const Subtle: Story = {
  args: { variant: 'subtle' },
};

export const Accent: Story = {
  args: { variant: 'accent' },
};

export const WithTrailingIcon: Story = {
  args: { variant: 'subtle', icon: ArrowRightIcon },
};

export const ExternalLink: Story = {
  args: {
    variant: 'accent',
    href: 'https://docs.filecoin.io',
    children: 'Read the docs',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="w-36 text-xs text-zinc-400">subtle</span>
        <Link variant="subtle" href="/buckets">
          View all buckets
        </Link>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-36 text-xs text-zinc-400">accent</span>
        <Link variant="accent" href="/buckets">
          View all buckets
        </Link>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-36 text-xs text-zinc-400">with icon</span>
        <Link variant="subtle" href="/buckets" icon={ArrowRightIcon}>
          View all buckets
        </Link>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-36 text-xs text-zinc-400">external (auto)</span>
        <Link variant="accent" href="https://docs.filecoin.io">
          Read the docs
        </Link>
      </div>
    </div>
  ),
};
