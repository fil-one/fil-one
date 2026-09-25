import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { INSTATUS_PAGE_URL, type InstatusSummary } from '../lib/instatus';
import { queryKeys } from '../lib/query-client';
import { StatusIndicator } from './StatusIndicator';

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

type Args = { variant: 'row' | 'pill'; status: string };

const meta: Meta<Args> = {
  title: 'Components/StatusIndicator',
  argTypes: {
    variant: { control: 'inline-radio', options: ['row', 'pill'] },
    status: {
      control: 'select',
      options: ['UP', 'HASISSUES', 'UNDERMAINTENANCE', 'UNKNOWN'],
    },
  },
  render: ({ variant, status }) => {
    const [queryClient] = useState(() => createSeededQueryClient(status));
    return (
      <QueryClientProvider client={queryClient}>
        {/* The pill sits in the utility bar's flex row, which sizes it to its content. */}
        <div style={variant === 'row' ? { width: 240 } : { display: 'flex' }}>
          <StatusIndicator variant={variant} />
        </div>
      </QueryClientProvider>
    );
  },
};

export default meta;
type Story = StoryObj<Args>;

export const AllSystemsOperational: Story = {
  args: { variant: 'row', status: 'UP' },
};

export const ServiceDisruption: Story = {
  args: { variant: 'row', status: 'HASISSUES' },
};

export const UnderMaintenance: Story = {
  args: { variant: 'row', status: 'UNDERMAINTENANCE' },
};

export const StatusUnavailable: Story = {
  args: { variant: 'row', status: 'UNKNOWN' },
};

export const Pill: Story = {
  args: { variant: 'pill', status: 'UP' },
};
