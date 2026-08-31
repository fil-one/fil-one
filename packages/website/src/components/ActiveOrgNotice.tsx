import { useEffect } from 'react';

import { takeReconcileNotice } from '../lib/active-org.js';
import { useToast } from './Toast/index.js';

/**
 * Say so when the tab came back in a different org than it asked for.
 *
 * `reconcileActiveOrg` clears a stale stash and reloads, which is the right
 * recovery and an invisible one: a header a proxy keeps stripping turns every
 * switcher click into a reload that lands back on the caller's own org, and
 * nothing on the page distinguishes that from a switch that worked. The reload
 * throws away any state a component could have carried, so the flag crosses it
 * in `sessionStorage` and is read once here.
 *
 * Mounted at the root, above the routes, so the notice survives whichever page
 * the reload lands on.
 */
export function ActiveOrgNotice() {
  const { toast } = useToast();

  useEffect(() => {
    if (takeReconcileNotice()) {
      toast.info(
        'You are back in your own organization. The one this tab had chosen is no longer available.',
      );
    }
  }, [toast]);

  return null;
}
