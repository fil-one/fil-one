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
    onChange: () => {},
  },
};

export const UsMidwest1: Story = {
  args: {
    value: S3Region.UsMidwest1,
    onChange: () => {},
  },
};

export const Disabled: Story = {
  args: {
    value: S3Region.EuWest1,
    disabled: true,
    onChange: () => {},
  },
};

export const Interactive: Story = {
  render: () => {
    const [region, setRegion] = useState<S3Region>(S3Region.EuWest1);
    return <RegionSelect value={region} onChange={setRegion} />;
  },
};
