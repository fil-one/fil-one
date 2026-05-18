import type { Meta, StoryObj } from '@storybook/react-vite';

import { AuthLayout } from './AuthLayout';
import { Button } from './Button';
import { Input } from './Input';

const meta: Meta<typeof AuthLayout> = {
  title: 'Components/AuthLayout',
  component: AuthLayout,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof AuthLayout>;

export const Default: Story = {
  render: () => (
    <AuthLayout>
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h2 className="text-2xl font-semibold text-zinc-950">Sign in</h2>
        <Input onChange={() => {}} placeholder="Email address" />
        <Button variant="primary">Continue</Button>
      </div>
    </AuthLayout>
  ),
};
