import type { MeResponse, OrgMembershipSummary } from '@filone/shared';

/**
 * `slug` is landing on `OrgMembershipSummary` from a parallel backend change
 * (org-scoped routing, FIL org-slug work) that has not shipped in `@filone/shared`
 * yet. Narrowed locally here rather than widening the shared type ahead of it —
 * once the field lands upstream this alias collapses to `OrgMembershipSummary`
 * itself and every call site below can drop the cast.
 */
export type MembershipWithSlug = OrgMembershipSummary & { slug?: string };

function membershipsWithSlug(
  me: Pick<MeResponse, 'memberships'>,
): MembershipWithSlug[] | undefined {
  return me.memberships as MembershipWithSlug[] | undefined;
}

/** The membership, if any, whose slug matches the org segment in the URL. */
export function findMembershipBySlug(
  me: Pick<MeResponse, 'memberships'>,
  slug: string,
): MembershipWithSlug | undefined {
  return membershipsWithSlug(me)?.find((membership) => membership.slug === slug);
}

/** The membership for the org the server resolved this session in. */
export function findActiveMembership(
  me: Pick<MeResponse, 'memberships' | 'orgId'>,
): MembershipWithSlug | undefined {
  return membershipsWithSlug(me)?.find((membership) => membership.orgId === me.orgId);
}

/** The membership for a specific org id, for switching into a non-active one. */
export function findMembershipByOrgId(
  me: Pick<MeResponse, 'memberships'>,
  orgId: string,
): MembershipWithSlug | undefined {
  return membershipsWithSlug(me)?.find((membership) => membership.orgId === orgId);
}
