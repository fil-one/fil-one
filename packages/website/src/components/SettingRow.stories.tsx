import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './Button';
import { SettingRow } from './SettingRow';

const meta: Meta<typeof SettingRow> = {
  title: 'Components/SettingRow',
  component: SettingRow,
};

export default meta;
type Story = StoryObj<typeof SettingRow>;

export const Default: Story = {
  args: {
    label: 'Password',
    description: 'Change your account password',
    action: (
      <Button variant="ghost" size="sm">
        Change
      </Button>
    ),
  },
};

export const Stacked: Story = {
  render: () => (
    <div className="flex flex-col gap-3 w-[480px]">
      <SettingRow
        label="Two-factor authentication"
        description="Your account is protected with two-factor authentication"
        action={
          <Button variant="ghost" size="sm">
            Add authenticator or key
          </Button>
        }
      />
      <div className="h-px bg-[#e1e4ea]" />
      <SettingRow
        label="Password"
        description="Change your account password"
        action={
          <Button variant="ghost" size="sm">
            Change
          </Button>
        }
      />
    </div>
  ),
};
