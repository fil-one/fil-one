import type { Meta, StoryObj } from '@storybook/react-vite';

import { UserAvatar } from './UserAvatar';

const meta: Meta<typeof UserAvatar> = {
  title: 'Components/UserAvatar',
  component: UserAvatar,
};

export default meta;
type Story = StoryObj<typeof UserAvatar>;

export const Initial: Story = {
  args: { initial: 'F' },
};

export const Picture: Story = {
  args: { initial: 'F', src: 'https://avatars.githubusercontent.com/u/9919?s=64&v=4' },
};

export const BrokenPictureFallsBack: Story = {
  args: { initial: 'F', src: 'https://example.invalid/missing.png' },
};

export const InContext: Story = {
  render: () => (
    <div className="flex w-60 items-center gap-2.5 rounded-lg border border-zinc-200 px-2 py-1.5">
      <UserAvatar initial="F" src="https://avatars.githubusercontent.com/u/9919?s=64&v=4" />
      <div className="min-w-0 overflow-hidden text-left">
        <p className="truncate text-sm font-medium leading-tight text-zinc-900">Filipa Ribeiro</p>
        <p className="truncate text-xs leading-tight text-zinc-500">Fil One</p>
      </div>
    </div>
  ),
};
