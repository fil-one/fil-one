import { PageLayout } from '../components/PageLayout.js';
import { RequirePermission } from '../components/RequirePermission';
import { OrganizationAuditTab } from './OrganizationAuditTab.js';

/**
 * `/audit`, a page of its own for every org, reached from the org switcher
 * alongside Members and Billing.
 *
 * Distinct from the dashboard's activity feed, which is synthesized from what
 * exists now and readable by every role: this is what was written down as it
 * happened, and only Owner and Admin (`audit.view`) may read it.
 */
export function AuditPage() {
  return (
    <PageLayout title="Audit log" description="The organization's recorded history">
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
