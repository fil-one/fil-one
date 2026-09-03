import { PageLayout } from '../components/PageLayout.js';
import { RequirePermission } from '../components/RequirePermission';
import { OrganizationAuditTab } from './OrganizationAuditTab.js';

const AUDIT_DESCRIPTION = "The organization's recorded history";

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
    <RequirePermission
      permission="audit.view"
      pending={
        <PageLayout title="Audit log" description={AUDIT_DESCRIPTION}>
          {null}
        </PageLayout>
      }
      fallback={
        <PageLayout title="Audit log" description={AUDIT_DESCRIPTION}>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
            The audit log is available to your organization&rsquo;s owners and admins.
          </div>
        </PageLayout>
      }
    >
      <PageLayout title="Audit log" description={AUDIT_DESCRIPTION}>
        <OrganizationAuditTab />
      </PageLayout>
    </RequirePermission>
  );
}
