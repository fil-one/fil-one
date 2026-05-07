import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { InstatusSummary } from '../lib/instatus';
import { queryKeys } from '../lib/query-client';
import { StatusIndicator } from './StatusIndicator';

function createSeededQueryClient(status: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const summary: InstatusSummary = {
    page: { name: 'Fil One', url: 'https://fil-one.instatus.com', status },
  };
  client.setQueryData(queryKeys.instatusSummary, summary);
  return client;
}

type Args = { collapsed: boolean; status: string };

const meta: Meta<Args> = {
  title: 'Components/StatusIndicator',
  argTypes: {
    collapsed: { control: 'boolean' },
    status: {
      control: 'select',
      options: ['UP', 'HASISSUES', 'UNDERMAINTENANCE', 'UNKNOWN'],
    },
  },
  render: ({ collapsed, status }) => {
    const [queryClient] = useState(() => createSeededQueryClient(status));
    return (
      <QueryClientProvider client={queryClient}>
        <div style={{ width: collapsed ? 56 : 240 }}>
          <StatusIndicator collapsed={collapsed} />
        </div>
      </QueryClientProvider>
    );
  },
};

export default meta;
type Story = StoryObj<Args>;

export const AllSystemsOperational: Story = {
  args: { collapsed: false, status: 'UP' },
};

export const ServiceDisruption: Story = {
  args: { collapsed: false, status: 'HASISSUES' },
};

export const UnderMaintenance: Story = {
  args: { collapsed: false, status: 'UNDERMAINTENANCE' },
};

export const StatusUnavailable: Story = {
  args: { collapsed: false, status: 'UNKNOWN' },
};

export const Collapsed: Story = {
  args: { collapsed: true, status: 'UP' },
};
