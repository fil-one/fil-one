import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';

import { Accordion } from './Accordion';

const meta: Meta<typeof Accordion> = {
  title: 'Components/Accordion',
  component: Accordion,
  args: {
    items: [
      {
        title: 'Can I make a bucket public?',
        content:
          'Public buckets are not currently supported. To share individual files, generate a presigned URL.',
      },
      {
        title: 'Can I pay with FIL tokens?',
        content: 'Not currently. Billing is in USD.',
      },
      {
        title:
          'A question long enough to wrap onto a second line beside the caret on narrow screens',
        content: 'The caret stays on the first line and the question wraps under itself.',
      },
    ],
  },
  decorators: [
    (Story) => (
      <div className="max-w-[520px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof Accordion>;

export const Default: Story = {};

export const OneOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Can I make a bucket public?' }));
  },
};
