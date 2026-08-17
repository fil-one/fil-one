import type { Meta, StoryObj } from '@storybook/react-vite';
import { ClockCounterClockwiseIcon, HourglassIcon, LockIcon } from '@phosphor-icons/react/dist/ssr';

import { PropertyCard } from './PropertyCard';

const meta: Meta<typeof PropertyCard> = {
  title: 'Components/PropertyCard',
  component: PropertyCard,
  args: {
    icon: HourglassIcon,
    label: 'Retention',
    value: 'Compliance · 15 days',
    enabled: true,
    tooltip: 'Applied to every object in this bucket.',
  },
};

export default meta;
type Story = StoryObj<typeof PropertyCard>;

export const Default: Story = {};

export const Enabled: Story = {
  args: {
    icon: ClockCounterClockwiseIcon,
    label: 'Versioning',
    value: 'Enabled',
    enabled: true,
    tooltip: 'Keeps multiple versions of each object',
  },
};

export const Disabled: Story = {
  args: {
    icon: LockIcon,
    label: 'Object Lock',
    value: 'Disabled',
    enabled: false,
    tooltip: 'Prevents deletion or modification during a retention period',
  },
};
