import type { Meta, StoryObj } from '@storybook/react-vite';

import { DatabaseIcon, KeyIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from './Button';
import { EmptyStateCard } from './EmptyStateCard';

const meta: Meta<typeof EmptyStateCard> = {
  title: 'Components/EmptyStateCard',
  component: EmptyStateCard,
};

export default meta;
type Story = StoryObj<typeof EmptyStateCard>;

export const Default: Story = {
  args: {
    icon: DatabaseIcon,
    title: 'No buckets yet',
    titleTag: 'h2',
    description: 'Create your first bucket to start storing objects.',
  },
};

export const WithAction: Story = {
  render: () => (
    <EmptyStateCard
      icon={KeyIcon}
      title="No API keys"
      titleTag="h2"
      description="Generate an API key to access your buckets programmatically."
    >
      <Button variant="primary">Create API key</Button>
    </EmptyStateCard>
  ),
};
