import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { MembersPage } from '../../pages/MembersPage';
import { PageLayout } from '../../components/PageLayout';
import { RequirePermissionPage } from '../../components/RequirePermissionPage';
import { useMembersSurface } from '../../lib/use-members-surface';

/**
 * `/members`, behind the surface gate first and the permission second.
 *
 * The gate answers a different question from the permission. `members.read` is
 * held by all four roles, so it cannot say whether this org has a members
 * surface — only whether this caller may read one. A solo org outside the
 * organizations beta has none, and a URL somebody kept is the only way to reach
 * it, so the page says the feature is not on rather than blaming the role.
 *
 * The refusal renders rather than redirecting, for the reason
 * `RequirePermissionPage` gives: a redirect costs `/me` on every navigation and
 * hands the caller no explanation.
 */
function MembersRoute() {
  const { visible, isPending, isError } = useMembersSurface();

  // The heading is true in every state, so it goes up while `/me` is in flight.
  if (isPending) return <PageLayout title="Members">{null}</PageLayout>;

  // A failed `/me` is not a denial. Same fail-quiet as `RequirePermission`:
  // telling a member of a real multi-member org that their org has no members
  // would be worse than showing them nothing.
  if (isError) return null;

  if (!visible) {
    return (
      <PageLayout title="Members">
        <div
          data-testid="members-not-enabled"
          className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600"
        >
          Inviting teammates is not enabled for this organization yet.
        </div>
      </PageLayout>
    );
  }

  return (
    <RequirePermissionPage
      permission="members.read"
      title="Members"
      deniedMessage="Reading this organization's members is not part of your role."
    >
      <MembersPage />
    </RequirePermissionPage>
  );
}

export const Route = createRoute({
  path: '/members',
  getParentRoute: () => appRoute,
  component: MembersRoute,
});
