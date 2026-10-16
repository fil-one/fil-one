import type { Meta, StoryObj } from '@storybook/react-vite';

import { OrgAvatar } from './OrgAvatar';

const meta: Meta<typeof OrgAvatar> = {
  title: 'Components/OrgAvatar',
  component: OrgAvatar,
  argTypes: {
    size: { control: 'select', options: ['xs', 'sm', 'md', 'lg'] },
  },
};

export default meta;
type Story = StoryObj<typeof OrgAvatar>;

export const Monogram: Story = {
  args: { name: 'Fil One' },
};

export const Logo: Story = {
  args: {
    name: 'Fil One',
    logoUrl: 'https://avatars.githubusercontent.com/u/9919?s=64&v=4',
  },
};

export const BrokenLogoFallsBack: Story = {
  args: { name: 'Fil One', logoUrl: 'https://example.invalid/missing.png' },
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      <OrgAvatar name="Fil One" size="xs" />
      <OrgAvatar name="Fil One" size="sm" />
      <OrgAvatar name="Fil One" size="md" />
      <OrgAvatar name="Fil One" size="lg" />
    </div>
  ),
};

export const InContext: Story = {
  render: () => (
    <div className="flex w-60 items-center gap-2.5 rounded-lg border border-zinc-200 px-2 py-1.5">
      <OrgAvatar name="Fil One" />
      <div className="min-w-0 overflow-hidden text-left">
        <p className="truncate text-sm font-medium leading-tight text-zinc-900">Fil One</p>
        <p className="truncate text-xs leading-tight text-zinc-500">Organization</p>
      </div>
    </div>
  ),
};
