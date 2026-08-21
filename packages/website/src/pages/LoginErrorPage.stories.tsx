import type { Meta, StoryObj } from '@storybook/react-vite';

import { LoginErrorPage } from './LoginErrorPage';

const meta: Meta<typeof LoginErrorPage> = {
  title: 'Pages/LoginErrorPage',
  component: LoginErrorPage,
  parameters: { fullBleed: true, layout: 'fullscreen' },
  args: {
    error: 'Invalid state',
  },
};

export default meta;
type Story = StoryObj<typeof LoginErrorPage>;

export const Default: Story = {};

export const UnexpectedError: Story = {
  args: {
    error: 'An unexpected error occurred',
  },
};
