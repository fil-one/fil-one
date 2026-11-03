import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, userEvent, within } from 'storybook/test';

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

/** Send pressed on an empty form: each field shows what it needs under itself. */
export const MissingFields: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Send message' }));
    await expect(canvas.getByText('Choose a category.')).toBeInTheDocument();
    await expect(canvas.getByText('Tell us how we can help.')).toBeInTheDocument();
  },
};

/**
 * `/me` failed, so the form asks for an email and the ticket goes without a
 * name or organization.
 */
export const ProfileUnavailable: Story = {
  decorators: [
    (Story) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // Keeps the page from fetching `/me` again on mount, so the failure below stands.
      client.setQueryDefaults(queryKeys.me, { retryOnMount: false });
      void client.prefetchQuery({
        queryKey: queryKeys.me,
        queryFn: () => Promise.reject(new Error('Profile unavailable')),
      });
      return (
        <QueryClientProvider client={client}>
          <Story />
        </QueryClientProvider>
      );
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByPlaceholderText('you@example.com')).toBeInTheDocument();
  },
};
