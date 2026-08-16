import type { ReactNode } from 'react';
import type { Permission } from '@filone/shared';

import { usePermissions } from '../lib/use-permissions.js';

interface RequirePermissionProps {
  /** What the wrapped surface needs. */
  permission: Permission;
  /** The surface itself — a destructive control, an admin panel, a whole page. */
  children: ReactNode;
  /**
   * What to show instead. Omitted, the surface simply is not there, which is
   * right for a button in a row of buttons; a page wants an explanation.
   */
  fallback?: ReactNode;
  /**
   * What to show while `/me` is in flight. Omitted, nothing renders — a
   * destructive control that appears and then vanishes is worse than one that
   * arrives a moment late.
   */
  pending?: ReactNode;
}

/**
 * Render children only for a caller whose role carries `permission`.
 *
 * Fail-closed at every step: pending renders `pending` (nothing by default) and
 * only an explicit yes renders the children. The server enforces regardless —
 * this hides what the API would refuse, so that a member is not offered a
 * button that returns a 403.
 *
 * A failed `/me` renders nothing at all, not the fallback. The fallback says why
 * a surface is missing, and "Billing is managed by your organization's owners"
 * is a claim about the caller's role — false, and unhelpfully so, when the truth
 * is that the request failed. An Owner whose network dropped should not be told
 * they are not an Owner.
 */
export function RequirePermission({
  permission,
  children,
  fallback = null,
  pending = null,
}: RequirePermissionProps) {
  const { has, isPending, isError } = usePermissions();

  if (isPending) return <>{pending}</>;
  if (isError) return null;
  return has(permission) ? <>{children}</> : <>{fallback}</>;
}
