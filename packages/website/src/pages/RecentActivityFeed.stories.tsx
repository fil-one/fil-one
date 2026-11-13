import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { RecentActivity } from '@filone/shared';

import { Card } from '../components/Card';
import { RecentActivityFeed } from './RecentActivityFeed';

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

/**
 * The feed inside the dashboard's card, fed by a real query so it goes through
 * the same loading and success states as on the page.
 */
function RecentActivityCard({
  activities,
  hasResources = true,
}: {
  activities: RecentActivity[];
  hasResources?: boolean;
}) {
  const activityQuery = useQuery({
    queryKey: ['story-activity', activities],
    queryFn: () => Promise.resolve({ activities }),
  });
  return (
    <div className="max-w-2xl">
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Recent Activity
          </h2>
          <a href="#" className="text-meta">
            View all
          </a>
        </div>
        <RecentActivityFeed activityQuery={activityQuery} hasResources={hasResources} />
      </Card>
    </div>
  );
}

const meta: Meta<typeof RecentActivityCard> = {
  title: 'Pages/Dashboard/RecentActivityFeed',
  component: RecentActivityCard,
  decorators: [
    (Story) => (
      <QueryClientProvider client={new QueryClient()}>
        <Story />
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof RecentActivityCard>;

/**
 * Console actions beside buckets made with the S3 API (the CLI, an SDK,
 * Terraform). The audit log has no record of those, so they read "Created
 * outside the console".
 */
export const ConsoleAndOutside: Story = {
  args: {
    activities: [
      {
        id: 'outside-1',
        resourceType: 'bucket',
        action: 'bucket.created',
        resourceName: 'terraform-state',
        timestamp: minutesAgo(4),
        createdOutsideConsole: true,
      },
      {
        id: 'console-1',
        resourceType: 'bucket',
        action: 'bucket.created',
        resourceName: 'product-images',
        timestamp: minutesAgo(35),
      },
      {
        id: 'console-2',
        resourceType: 'key',
        action: 'key.created',
        resourceName: 'ci-deploy',
        timestamp: minutesAgo(90),
      },
      {
        id: 'outside-2',
        resourceType: 'bucket',
        action: 'bucket.created',
        resourceName: 'backups-2026',
        timestamp: minutesAgo(60 * 26),
        createdOutsideConsole: true,
      },
      {
        id: 'console-3',
        resourceType: 'bucket',
        action: 'bucket.deleted',
        resourceName: 'old-logs',
        timestamp: minutesAgo(60 * 24 * 3),
      },
    ],
  },
};

/** Every row from the console: the feed as it was before this change. */
export const ConsoleOnly: Story = {
  args: {
    activities: [
      {
        id: 'console-1',
        resourceType: 'bucket',
        action: 'bucket.created',
        resourceName: 'product-images',
        timestamp: minutesAgo(35),
      },
      {
        id: 'console-2',
        resourceType: 'key',
        action: 'key.rotated',
        resourceName: 'ci-deploy',
        timestamp: minutesAgo(90),
      },
      {
        id: 'console-3',
        resourceType: 'bucket',
        action: 'bucket.deleted',
        resourceName: 'old-logs',
        timestamp: minutesAgo(60 * 24 * 3),
      },
    ],
  },
};

/** An org with buckets and keys but nothing in the last 90 days. */
export const NoRecentActivity: Story = {
  args: { activities: [] },
};

/** A new org with nothing yet. */
export const NoActivityYet: Story = {
  args: { activities: [], hasResources: false },
};
