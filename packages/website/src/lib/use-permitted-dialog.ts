import { useEffect, useState } from 'react';

/**
 * Dialog state that closes itself when the permission behind it goes away.
 *
 * The same shape as the round-2 panels and the round-3 form selection: hiding
 * an opener decides only what can be started, and a dialog already on screen is
 * state the caller chose before the demotion. It keeps rendering its confirm
 * button after the row that opened it disappears, so the confirm earns the 403
 * the hidden opener exists to avoid. `BillingPage`'s payment dialog is the
 * sharp end — it can confirm an already-issued Stripe SetupIntent against an
 * `activateSubscription` that then refuses.
 *
 * `closed` is the value that means "not open" — `false` for a boolean flag,
 * `null` for a dialog that carries its target. `permitted` is read on every
 * render and only while the dialog is open, so a dialog whose gate depends on
 * the target it holds (indexing a bucket is `buckets.create`, un-indexing it is
 * `buckets.delete`) passes a function.
 *
 * Unlike the form-selection prune, this does not wait for `/me` to answer.
 * `usePermissions` grants nothing while the query is pending or failed, and a
 * dialog that is open at all was opened by a control that had already seen a
 * yes; closing on a failed refetch matches `RequirePermission`, which takes the
 * opener away in the same render.
 */
export function usePermittedDialog<T>(
  closed: T,
  permitted: boolean | ((value: T) => boolean),
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(closed);
  const open = !Object.is(value, closed);
  const stillPermitted = !open || (typeof permitted === 'function' ? permitted(value) : permitted);

  useEffect(() => {
    if (open && !stillPermitted) setValue(closed);
  });

  return [value, setValue];
}
