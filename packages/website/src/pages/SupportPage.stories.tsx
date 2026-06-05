import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';

import { SupportPage } from './SupportPage';

const meta: Meta<typeof SupportPage> = {
  title: 'Pages/SupportPage',
  component: SupportPage,
};

export default meta;
type Story = StoryObj<typeof SupportPage>;

export const Default: Story = {};

export const FilledIn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText('Jane'), 'Jane');
    await userEvent.type(canvas.getByPlaceholderText('Smith'), 'Smith');
    await userEvent.type(canvas.getByPlaceholderText('Acme Inc.'), 'Acme Inc.');
    await userEvent.type(canvas.getByPlaceholderText('you@example.com'), 'jane@acme.com');
    await userEvent.click(canvas.getByLabelText('Product Issue'));
    await userEvent.type(
      canvas.getByPlaceholderText('How can we help?'),
      'I need help with my account.',
    );
  },
};
