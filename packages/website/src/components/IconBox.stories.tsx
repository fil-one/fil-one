import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  DatabaseIcon,
  KeyIcon,
  FolderIcon,
  GearIcon,
  WarningIcon,
} from '@phosphor-icons/react/dist/ssr';

import { IconBox, type IconBoxColor, type IconBoxSize } from './IconBox';

const meta: Meta<typeof IconBox> = {
  title: 'Components/IconBox',
  component: IconBox,
  argTypes: {
    color: { control: 'select', options: ['blue', 'green', 'red', 'grey', 'amber'] },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
  },
};

export default meta;
type Story = StoryObj<typeof IconBox>;

export const Default: Story = {
  args: { icon: DatabaseIcon, color: 'blue', size: 'md' },
};

export const AllColors: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <IconBox icon={DatabaseIcon} color="blue" />
      <IconBox icon={FolderIcon} color="green" />
      <IconBox icon={WarningIcon} color="red" />
      <IconBox icon={GearIcon} color="grey" />
      <IconBox icon={WarningIcon} color="amber" />
    </div>
  ),
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      <IconBox icon={DatabaseIcon} size="sm" />
      <IconBox icon={DatabaseIcon} size="md" />
      <IconBox icon={DatabaseIcon} size="lg" />
    </div>
  ),
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {(['blue', 'green', 'red', 'grey', 'amber'] as IconBoxColor[]).map((color) => (
        <div key={color} className="flex items-end gap-4">
          {(['sm', 'md', 'lg'] as IconBoxSize[]).map((size) => (
            <IconBox key={size} icon={KeyIcon} color={color} size={size} />
          ))}
        </div>
      ))}
    </div>
  ),
};
