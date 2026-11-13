import type { UseQueryResult } from '@tanstack/react-query';
import { ClockCounterClockwiseIcon, PlusIcon } from '@phosphor-icons/react/dist/ssr';
import { AUDIT_RETENTION_DAYS, getActivityActionLabel } from '@filone/shared';
import type { RecentActivity, RecentActivityResponse } from '@filone/shared';

import { Alert } from '../components/Alert';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyStateCard } from '../components/EmptyStateCard';
import { RequirePermission } from '../components/RequirePermission';
import { Skeleton } from '../components/Skeleton';
import { timeAgo } from '../lib/time.js';

/** How many events the dashboard's feed shows. */
export const ACTIVITY_LIMIT = 5;

/**
 * The body of the Recent Activity card: a skeleton while the feed loads, an
 * error when it fails, and otherwise the feed or its empty state. A failed or
 * loading feed must not read as "No recent activity", which would state as fact
 * that nothing happened.
 */
export function RecentActivityFeed({
  activityQuery,
  hasResources,
}: {
  activityQuery: UseQueryResult<RecentActivityResponse>;
  hasResources: boolean;
}) {
  if (activityQuery.isPending) {
    return (
      <div role="status" aria-label="Loading recent activity" className="flex flex-col gap-2">
        {Array.from({ length: ACTIVITY_LIMIT }, (_, index) => (
          <Skeleton key={index} className="h-10" />
        ))}
      </div>
    );
  }

  if (activityQuery.isError) {
    return (
      <Alert
        variant="red"
        description="Failed to load recent activity"
        action={
          <Button variant="ghost" size="sm" onClick={() => void activityQuery.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  const { activities } = activityQuery.data;
  return (
    <>
      {activities.length === 0 && hasResources ? (
        // The feed holds the audit log's retention window, so an org whose
        // buckets and keys are all older than it has resources and no activity.
        <EmptyStateCard
          icon={ClockCounterClockwiseIcon}
          iconColor="grey"
          title="No recent activity"
          description={`Bucket and key changes from the last ${AUDIT_RETENTION_DAYS} days appear here`}
          bordered={false}
        />
      ) : activities.length === 0 ? (
        <EmptyStateCard
          icon={ClockCounterClockwiseIcon}
          iconColor="grey"
          title="No activity yet"
          description="Create a bucket to start storing objects"
          bordered={false}
        >
          <RequirePermission permission="buckets.create">
            <Button
              id="dashboard-create-bucket-button"
              variant="primary"
              icon={PlusIcon}
              href="/buckets/create"
            >
              Create bucket
            </Button>
          </RequirePermission>
        </EmptyStateCard>
      ) : (
        <div className="divide-y divide-zinc-100/50">
          {activities.map((activity) => (
            <div key={activity.id} className="flex items-center gap-4 rounded-lg px-2 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-ui font-medium text-zinc-900">
                    {activity.resourceName}
                  </span>
                  <Badge color={activity.resourceType === 'bucket' ? 'grey' : 'blue'} size="sm">
                    {activity.resourceType}
                  </Badge>
                </div>
                <p className="mt-0.5 text-meta text-zinc-500">{getActivityLabel(activity)}</p>
              </div>
              <span className="w-14 shrink-0 text-right text-meta text-zinc-500">
                {timeAgo(activity.timestamp)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * What happened, under the resource's name. A bucket the console has no record
 * of creating says so, since the row names nobody and the audit page lacks it.
 */
function getActivityLabel(activity: RecentActivity): string {
  if (activity.resourceType === 'bucket' && activity.createdOutsideConsole) {
    return 'Created outside the console';
  }
  return getActivityActionLabel(activity.action);
}
