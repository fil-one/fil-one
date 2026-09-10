import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions';
import { ToastProvider } from './Toast/ToastProvider';
import { ReportBugButton } from './ReportBugButton';

function createSeededQueryClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner, { name: 'Ada Lovelace', email: 'ada@example.com' });
  return client;
}

const meta: Meta<typeof ReportBugButton> = {
  title: 'Components/ReportBugButton',
  component: ReportBugButton,
  decorators: [
    (Story) => (
      <QueryClientProvider client={createSeededQueryClient()}>
        <ToastProvider>
          <div className="flex size-8 items-center justify-center rounded-md border border-zinc-200 bg-white">
            <Story />
          </div>
        </ToastProvider>
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ReportBugButton>;

/** The quiet icon button as it sits in the content window's bottom bar. */
export const Default: Story = {};
