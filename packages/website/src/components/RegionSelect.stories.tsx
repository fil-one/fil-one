import { useState } from 'react';

import { S3Region } from '@filone/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { RegionSelect } from './RegionSelect';

const meta: Meta<typeof RegionSelect> = {
  title: 'Components/RegionSelect',
  component: RegionSelect,
};

export default meta;
type Story = StoryObj<typeof RegionSelect>;

export const Default: Story = {
  args: {
    value: S3Region.EuWest1,
  },
};

export const UsEast1: Story = {
  args: {
    value: S3Region.UsEast1,
  },
};

export const Disabled: Story = {
  args: {
    value: S3Region.EuWest1,
    disabled: true,
  },
};

export const Interactive: Story = {
  render: () => {
    const [region, setRegion] = useState<S3Region>(S3Region.EuWest1);
    return <RegionSelect value={region} onChange={setRegion} />;
  },
};
