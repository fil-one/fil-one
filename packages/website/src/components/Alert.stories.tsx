import type { Meta, StoryObj } from '@storybook/react-vite';

import { Alert } from './Alert';

const meta: Meta<typeof Alert> = {
  title: 'Components/Alert',
  component: Alert,
};

export default meta;
type Story = StoryObj<typeof Alert>;

export const Default: Story = {
  args: {
    title: 'Heads up',
    description: 'This is an informational alert to notify you of something important.',
  },
};

export const ShortMessage: Story = {
  args: {
    title: 'Note',
    description: 'Quick update.',
  },
};

export const LongDescription: Story = {
  args: {
    title: 'Storage limit approaching',
    description:
      'You have used 95% of your available storage. Consider upgrading your plan or removing unused objects to free up space before uploads are disabled.',
  },
};
