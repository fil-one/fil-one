import { useMemo, useState } from 'react';

export interface PendingRows {
  /** The rows a mutation is in flight for, for the table that renders them. */
  ids: ReadonlySet<string>;
  /** Called as a mutation starts. */
  add: (id: string) => void;
  /** Called when it settles, whichever way it went. */
  remove: (id: string) => void;
}

/**
 * The rows a mutation is in flight for.
 *
 * A `useMutation` instance carries one set of `variables`, so a table asking it
 * "which row are you working on" gets the latest answer rather than all of them:
 * start a second row while the first is still going and the first row's controls
 * come back mid-flight, offering a second click on a change already on its way.
 * The ids are tracked here instead — added when a mutation starts, dropped when
 * it settles — so several rows can be busy at once and each says so.
 */
export function usePendingRows(): PendingRows {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());

  return useMemo(
    () => ({
      ids,
      add: (id: string) =>
        setIds((old) => {
          const next = new Set(old);
          next.add(id);
          return next;
        }),
      remove: (id: string) =>
        setIds((old) => {
          const next = new Set(old);
          next.delete(id);
          return next;
        }),
    }),
    [ids],
  );
}
