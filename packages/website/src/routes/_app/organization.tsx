import z from 'zod';
import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { OrganizationPage, type OrganizationTabId } from '../../pages/OrganizationPage';
import { PageLayout } from '../../components/PageLayout';
import { RequirePermissionPage } from '../../components/RequirePermissionPage';
import { useMembersSurface } from '../../lib/use-members-surface';

/**
 * `tab` names which of the page's tabs opens, for the links that have a
 * particular one in mind: `/billing` redirects here with `tab=billing`, and
 * that is where the shell's Upgrade banner and Stripe's portal return land.
 *
 * `portal_return` rides along from `/billing` on the same trip —
 * `use-billing` reads it to know the plan or the card may have changed.
 */
const organizationSearchSchema = z.object({
  tab: z.enum(['members', 'invitations', 'audit', 'billing']).optional(),
  portal_return: z.string().optional(),
});

/**
 * `/organization`, behind the surface gate first and the permission second.
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
 *
 * Split from the route's own component so the gate can be rendered on its own:
 * everything it decides comes from `/me` and a tab name, and standing a router
 * up to hand it that tab name would test the router.
 */
export function OrganizationGate({ tab }: { tab?: OrganizationTabId }) {
  const { visible, isPending, isError } = useMembersSurface();

  // The heading is true in every state, so it goes up while `/me` is in flight.
  if (isPending) return <PageLayout title="Organization">{null}</PageLayout>;

  // A failed `/me` is not a denial. Same fail-quiet as `RequirePermission`:
  // telling a member of a real multi-member org that their org has none would
  // be worse than showing them nothing.
  if (isError) return null;

  if (!visible) {
    return (
      <PageLayout title="Organization">
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
      title="Organization"
      deniedMessage="Reading this organization is not part of your role."
    >
      <OrganizationPage tab={tab} />
    </RequirePermissionPage>
  );
}

function OrganizationRoute() {
  const { tab } = Route.useSearch();
  return <OrganizationGate tab={tab} />;
}

export const Route = createRoute({
  path: '/organization',
  getParentRoute: () => appRoute,
  component: OrganizationRoute,
  validateSearch: organizationSearchSchema,
});
