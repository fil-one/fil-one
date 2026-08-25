import type { Meta, StoryObj } from '@storybook/react-vite';

import { S3Region, getRegionLabel } from '@filone/shared';

import { RegionFlag } from './RegionFlag';

const meta: Meta<typeof RegionFlag> = {
  title: 'Components/RegionFlag',
  component: RegionFlag,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof RegionFlag>;

export const Default: Story = {
  args: { region: S3Region.EuWest1 },
};

export const AllRegions: Story = {
  render: () => (
    <div className="flex flex-col gap-3 p-4">
      {Object.values(S3Region).map((region) => (
        <div key={region} className="flex items-center gap-2.5 text-xs">
          <RegionFlag region={region} />
          <span className="font-medium text-zinc-900">{getRegionLabel(region)}</span>
          <span className="text-zinc-500">{region}</span>
        </div>
      ))}
    </div>
  ),
};

/** An unrecognized region renders label-only rather than a broken glyph. */
export const UnknownRegion: Story = {
  args: { region: 'ap-south-1' },
  render: (args) => (
    <div className="flex items-center gap-2 text-xs">
      <RegionFlag {...args} />
      <span className="text-zinc-500">ap-south-1 (no flag)</span>
    </div>
  ),
};
