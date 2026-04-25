import type { Meta, StoryObj } from '@storybook/react-vite';

import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/ssr';

import { SplitButton } from './SplitButton';

const meta: Meta<typeof SplitButton> = {
  title: 'Components/SplitButton',
  component: SplitButton,
};

export default meta;
type Story = StoryObj<typeof SplitButton>;

export const Default: Story = {
  args: {
    label: 'Download .csv',
    icon: DownloadSimpleIcon,
    onMainClick: () => {},
    items: [{ label: 'Download .env', icon: DownloadSimpleIcon, onClick: () => {} }],
  },
};

export const Ghost: Story = {
  args: {
    variant: 'ghost',
    label: 'Download .csv',
    icon: DownloadSimpleIcon,
    onMainClick: () => {},
    items: [{ label: 'Download .env', icon: DownloadSimpleIcon, onClick: () => {} }],
  },
};
