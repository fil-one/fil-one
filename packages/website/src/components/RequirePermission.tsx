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
 * Fail-closed at every step: pending renders `pending` (nothing by default),
 * a failed `/me` renders the fallback, and only an explicit yes renders the
 * children. The server enforces regardless — this hides what the API would
 * refuse, so that a member is not offered a button that returns a 403.
 */
export function RequirePermission({
  permission,
  children,
  fallback = null,
  pending = null,
}: RequirePermissionProps) {
  const { has, isPending } = usePermissions();

  if (isPending) return <>{pending}</>;
  return has(permission) ? <>{children}</> : <>{fallback}</>;
}
