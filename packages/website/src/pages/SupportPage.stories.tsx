import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { userEvent, within } from 'storybook/test';

import { queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';
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
    await userEvent.click(canvas.getByLabelText('Product issue'));
    await userEvent.type(
      canvas.getByPlaceholderText('How can we help?'),
      'I need help with my account.',
    );
  },
};

/** An account whose sign-in method gave no email address, so the form asks for one. */
export const NoAccountEmail: Story = {
  decorators: [
    (Story) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryDefaults(queryKeys.me, { staleTime: Infinity });
      seedPermissions(client, undefined, { email: undefined });
      return (
        <QueryClientProvider client={client}>
          <Story />
        </QueryClientProvider>
      );
    },
  ],
};
