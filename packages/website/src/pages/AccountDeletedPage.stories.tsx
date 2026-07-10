import type { Meta, StoryObj } from '@storybook/react-vite';

import { AccountDeletedPage } from './AccountDeletedPage';

const meta: Meta<typeof AccountDeletedPage> = {
  title: 'Pages/AccountDeletedPage',
  component: AccountDeletedPage,
};

export default meta;
type Story = StoryObj<typeof AccountDeletedPage>;

export const Default: Story = {};
