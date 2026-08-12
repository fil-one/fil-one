import type { Meta, StoryObj } from '@storybook/react-vite';

import { PropertyCard } from './PropertyCard';

const meta: Meta<typeof PropertyCard> = {
  title: 'Components/PropertyCard',
  component: PropertyCard,
  args: {
    label: 'Encryption',
    value: 'Enabled',
    tooltip: 'Always on. All data is encrypted at rest.',
  },
};

export default meta;
type Story = StoryObj<typeof PropertyCard>;

export const Default: Story = {};

export const Enabled: Story = {
  args: {
    label: 'Versioning',
    value: 'Enabled',
    enabled: true,
    tooltip: 'Keeps multiple versions of each object',
  },
};

export const Disabled: Story = {
  args: {
    label: 'Object Lock',
    value: 'Disabled',
    enabled: false,
    tooltip: 'Prevents deletion or modification during a retention period',
  },
};
