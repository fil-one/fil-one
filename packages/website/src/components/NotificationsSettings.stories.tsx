import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { PreferencesResponse } from '@filone/shared';

import { queryKeys } from '../lib/query-client';
import { NotificationSettings } from './NotificationsSettings';
import { ToastProvider } from './Toast';

type SeedMode = 'optedOut' | 'optedIn' | 'loading';

function createSeededQueryClient(mode: SeedMode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (mode !== 'loading') {
    client.setQueryData<PreferencesResponse>(queryKeys.preferences, {
      marketingEmailsOptedIn: mode === 'optedIn',
    });
  }
  return client;
}

type Args = { initialState: SeedMode };

const meta: Meta<Args> = {
  title: 'Pages/Settings/NotificationsSection',
  argTypes: {
    initialState: {
      control: 'select',
      options: ['optedOut', 'optedIn', 'loading'],
    },
  },
  parameters: { layout: 'padded' },
  render: ({ initialState }) => {
    const [queryClient] = useState(() => createSeededQueryClient(initialState));
    return (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <div style={{ maxWidth: 672 }}>
            <NotificationSettings />
          </div>
        </ToastProvider>
      </QueryClientProvider>
    );
  },
};

export default meta;
type Story = StoryObj<Args>;

export const MarketingOff: Story = {
  args: { initialState: 'optedOut' },
};

export const MarketingOn: Story = {
  args: { initialState: 'optedIn' },
};

export const Loading: Story = {
  args: { initialState: 'loading' },
};
