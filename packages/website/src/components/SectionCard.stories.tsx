import { BellIcon, ShieldCheckIcon, TrashIcon, UserIcon } from '@phosphor-icons/react/dist/ssr';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { SectionCard } from './SectionCard';
import { ToggleRow } from './ToggleRow';

const meta: Meta<typeof SectionCard> = {
  title: 'Components/SectionCard',
  component: SectionCard,
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof SectionCard>;

export const Default: Story = {
  args: {
    icon: UserIcon,
    title: 'Profile',
    description: 'Your personal information',
    children: <p className="text-sm text-zinc-700">Section body content goes here.</p>,
  },
};

export const WithToggles: Story = {
  args: {
    icon: BellIcon,
    title: 'Notifications',
    description: 'Manage your notification preferences',
    children: (
      <div className="flex flex-col gap-3">
        <ToggleRow
          label="Email notifications"
          description="Get notified about your uploads and when approaching storage limits"
          enabled={false}
          disabled
        />
        <div className="h-px bg-[#e1e4ea]" />
        <ToggleRow
          label="Marketing emails"
          description="Receive updates about new features"
          enabled
        />
      </div>
    ),
  },
};

export const Security: Story = {
  args: {
    icon: ShieldCheckIcon,
    title: 'Security',
    description: 'Manage your account security',
    children: (
      <p className="text-sm text-zinc-700">
        Two-factor authentication, sessions, and password settings.
      </p>
    ),
  },
};

export const Danger: Story = {
  args: {
    icon: TrashIcon,
    title: 'Danger zone',
    description: 'Irreversible actions',
    danger: true,
    children: (
      <button
        type="button"
        className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
      >
        Delete account
      </button>
    ),
  },
};
