import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { INSTATUS_PAGE_URL, type InstatusSummary } from '../lib/instatus';
import { queryKeys } from '../lib/query-client';
import { SystemStatusPill } from './SystemStatusPill';

function createSeededQueryClient(status: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const summary: InstatusSummary = {
    page: { name: 'Fil One', url: INSTATUS_PAGE_URL, status },
  };
  client.setQueryData(queryKeys.instatusSummary, summary);
  return client;
}

type Args = { status: string };

const meta: Meta<Args> = {
  title: 'Components/SystemStatusPill',
  argTypes: {
    status: {
      control: 'select',
      options: ['UP', 'HASISSUES', 'UNDERMAINTENANCE', 'UNKNOWN'],
    },
  },
  render: ({ status }) => {
    const [queryClient] = useState(() => createSeededQueryClient(status));
    return (
      <QueryClientProvider client={queryClient}>
        <SystemStatusPill />
      </QueryClientProvider>
    );
  },
};

export default meta;
type Story = StoryObj<Args>;

/** Renders as a bare dot until hover or keyboard focus reveals the label. */
export const AllSystemsOperational: Story = {
  args: { status: 'UP' },
};

export const ServiceDisruption: Story = {
  args: { status: 'HASISSUES' },
};

export const UnderMaintenance: Story = {
  args: { status: 'UNDERMAINTENANCE' },
};

export const StatusUnavailable: Story = {
  args: { status: 'UNKNOWN' },
};
