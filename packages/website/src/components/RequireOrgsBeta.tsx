import type { ReactNode } from 'react';
import { Navigate } from '@tanstack/react-router';

import { usePermissions } from '../lib/use-permissions.js';

/**
 * A page of the organizations beta. Outside it the page does not exist, so the
 * caller lands on the dashboard rather than on an explanation.
 */
export function RequireOrgsBeta({ children }: { children: ReactNode }) {
  const { orgsBeta, isPending, isError } = usePermissions();

  if (isPending || isError) return null;
  return orgsBeta ? <>{children}</> : <Navigate to="/dashboard" replace />;
}
