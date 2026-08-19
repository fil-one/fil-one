import type { Meta, StoryObj } from '@storybook/react-vite';

import { RouteErrorPage, RouteNotFoundPage } from './RouteRecoveryPage';

const meta: Meta<typeof RouteErrorPage> = {
  title: 'Components/RouteRecoveryPage',
  component: RouteErrorPage,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof RouteErrorPage>;

/** How a thrown route error renders inside AppShell's content area. */
export const RouteError: Story = {
  args: {
    error: new Error('Cannot read properties of undefined (reading region)'),
    reset: () => {},
    info: undefined,
  },
};

/** How an unmatched URL renders, where there is no app chrome to sit inside. */
export const NotFound: Story = {
  render: () => <RouteNotFoundPage />,
};
