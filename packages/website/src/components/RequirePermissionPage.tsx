import type { ReactNode } from 'react';
import type { Permission } from '@filone/shared';

import { PageLayout } from './PageLayout.js';
import { RequirePermission } from './RequirePermission.js';

interface RequirePermissionPageProps {
  /** What the page needs. */
  permission: Permission;
  /** The page heading, shown in every state so the denial is not a blank screen. */
  title: string;
  /** What a caller who cannot open the page is told instead. */
  deniedMessage: string;
  children: ReactNode;
}

/**
 * A whole page behind one permission.
 *
 * Gating only the button that navigates here leaves the page reachable by URL,
 * back button, or a stale bookmark, and the form then fails at submit with a
 * 403 after the caller has filled it in. This says so before the work.
 *
 * The route could refuse in `beforeLoad` instead, but that would need `/me` on
 * the critical path of every navigation and gives the caller a redirect with no
 * explanation. Rendering the answer keeps the reason attached to it.
 */
export function RequirePermissionPage({
  permission,
  title,
  deniedMessage,
  children,
}: RequirePermissionPageProps) {
  return (
    <RequirePermission
      permission={permission}
      // The heading is true in every state, so it goes up while `/me` is in
      // flight rather than leaving a blank page that then fills in.
      pending={<PageLayout title={title}>{null}</PageLayout>}
      fallback={
        <PageLayout title={title}>
          <div
            data-testid="page-permission-denied"
            className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600"
          >
            {deniedMessage}
          </div>
        </PageLayout>
      }
    >
      {children}
    </RequirePermission>
  );
}
