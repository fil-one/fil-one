import type { Meta, StoryObj } from '@storybook/react-vite';

import { InfoSidebar } from './InfoSidebar';

const meta: Meta<typeof InfoSidebar> = {
  title: 'Components/InfoSidebar',
  component: InfoSidebar,
};

export default meta;
type Story = StoryObj<typeof InfoSidebar>;

export const Default: Story = {
  args: {
    heading: 'Included by default',
    items: [
      {
        title: 'Encryption',
        description: 'All data is encrypted at rest by default.',
      },
      {
        title: 'Private',
        description: 'All buckets are private by default. Access requires an API key.',
      },
      {
        title: 'Versioning',
        description: 'Multiple versions of every object are kept automatically.',
      },
      {
        title: 'Object Lock',
        description: 'Objects are protected from deletion or modification by default.',
      },
    ],
  },
};

export const ApiKeys: Story = {
  args: {
    heading: 'About API keys',
    items: [
      {
        title: 'Scoped access',
        description: 'Keys can be restricted to specific buckets and permissions.',
      },
      {
        title: 'Secure credentials',
        description: 'The secret key is only shown once at creation time. Store it somewhere safe.',
      },
      {
        title: 'Revocable',
        description: 'Delete a key at any time to immediately revoke access.',
      },
      {
        title: 'Expiration',
        description: 'Optionally set an expiry date so keys rotate automatically.',
      },
    ],
  },
};

export const SingleItem: Story = {
  args: {
    heading: 'Note',
    items: [
      {
        title: 'Immutable',
        description: 'This setting cannot be changed after the bucket is created.',
      },
    ],
  },
};
