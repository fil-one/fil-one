import { useQuery } from '@tanstack/react-query';

import { PageLayout } from '../components/PageLayout.js';
import { RequirePermission } from '../components/RequirePermission';
import { getMe } from '../lib/api.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { OrganizationAuditTab } from './OrganizationAuditTab.js';

/**
 * `/audit`, a page of its own for every org, reached from the org switcher
 * alongside Members and Billing.
 *
 * Distinct from the dashboard's activity feed, which is synthesized from what
 * exists now and readable by every role: this is what was written down as it
 * happened, and only Owner and Admin (`audit.view`) may read it.
 *
 * The subtitle names the org: a member of several orgs sees only the active
 * one's log here, and a screenshot of it rarely includes the sidebar's org
 * switcher. Until `/me` answers there is no name, so there is no subtitle.
 */
export function AuditPage() {
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  return (
    <PageLayout
      title="Audit log"
      description={me?.orgName ? `Activity in ${me.orgName}` : undefined}
    >
      <RequirePermission
        permission="audit.view"
        fallback={
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
            The audit log is available to your organization&rsquo;s owners and admins.
          </div>
        }
      >
        <OrganizationAuditTab />
      </RequirePermission>
    </PageLayout>
  );
}
