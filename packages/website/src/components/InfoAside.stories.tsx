import type { Meta, StoryObj } from '@storybook/react-vite';

import { InfoAside } from './InfoAside';

const meta: Meta<typeof InfoAside> = {
  title: 'Components/InfoAside',
  component: InfoAside,
};

export default meta;
type Story = StoryObj<typeof InfoAside>;

export const Default: Story = {
  args: {
    title: 'Included by default',
    items: [
      { title: 'Encryption', description: 'All data is encrypted at rest.' },
      { title: 'Private', description: 'All buckets are private. Access requires an API key.' },
    ],
  },
};

export const LongDescriptions: Story = {
  args: {
    title: 'Good to know',
    items: [
      {
        title: 'Keep your secret safe',
        description:
          'Your secret access key grants full access to your data. Never share it with anyone, including support. Store it in a secure location like a password manager or secrets vault.',
      },
      {
        title: 'Scope by bucket',
        description:
          'Restrict keys to specific buckets to follow the principle of least privilege.',
      },
      {
        title: 'Set an expiry',
        description:
          'Keys can be set to expire automatically. Use short-lived keys for temporary access.',
      },
    ],
  },
};
