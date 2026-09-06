import type { Meta, StoryObj } from '@storybook/react-vite';

import { OrgAvatar } from './OrgAvatar';
import { AvatarUploadButton } from './AvatarUploadButton';

const meta: Meta<typeof AvatarUploadButton> = {
  title: 'Components/AvatarUploadButton',
  component: AvatarUploadButton,
  args: {
    size: 'h-14 w-14',
    shape: 'rounded-full',
    iconSize: 18,
    uploading: false,
    ariaLabel: 'Change avatar',
    onClick: () => {},
    children: <OrgAvatar name="Acme" size="md" />,
  },
  argTypes: {
    shape: { control: 'radio', options: ['rounded-full', 'rounded-xl'] },
  },
};

export default meta;
type Story = StoryObj<typeof AvatarUploadButton>;

export const Circle: Story = {};

export const Square: Story = {
  args: { shape: 'rounded-xl' },
};

export const Uploading: Story = {
  args: { uploading: true },
};

export const Disabled: Story = {
  args: { disabled: true },
};
