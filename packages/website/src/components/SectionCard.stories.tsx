import type { Meta, StoryObj } from '@storybook/react-vite';

import { SectionCard } from './SectionCard';

const meta: Meta<typeof SectionCard> = {
  title: 'Components/SectionCard',
  component: SectionCard,
};

export default meta;
type Story = StoryObj<typeof SectionCard>;

export const Default: Story = {
  args: {
    title: 'Identity',
    children: <p className="text-sm text-zinc-700">Org name, logo, and slug live here.</p>,
  },
};

export const Bare: Story = {
  args: {
    title: 'Members',
    bare: true,
    children: (
      <div className="divide-y divide-zinc-200">
        <div className="px-5 py-3 text-sm text-zinc-700">Filipa Ribeiro</div>
        <div className="px-5 py-3 text-sm text-zinc-700">Jordan Lee</div>
      </div>
    ),
  },
};
