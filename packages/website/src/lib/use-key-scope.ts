import { usePermissions } from './use-permissions.js';

/** The shape every key list shares: the console only needs its creator. */
interface KeyWithCreator {
  createdBy?: string;
}

/**
 * Who the caller may list and revoke keys for.
 *
 * Both key lists — S3 access keys and RAG keys — are `keys.manage_own`, and the
 * server narrows the response to the caller's own keys unless they also hold
 * `keys.manage_all`. The console mirrors the second half of that rule so a
 * Member is not offered a Revoke on a colleague's key that would come back 403,
 * and the first half is why the list query is gated at all: without
 * `keys.manage_own` the request is refused outright.
 *
 * Three call sites had `keys.manage_all` hardcoded, which hid Revoke from a
 * Member on the keys they minted themselves.
 */
export function useKeyActionScope(): {
  /** Whether the list request will be answered rather than refused. */
  mayList: boolean;
  /** Whether the caller may revoke this particular key. */
  mayRevoke: (key: KeyWithCreator) => boolean;
  /** Whether any key in a list is revocable — for a column header. */
  mayRevokeAny: (keys: readonly KeyWithCreator[]) => boolean;
} {
  const { has, userId } = usePermissions();

  const manageAll = has('keys.manage_all');
  const manageOwn = has('keys.manage_own');

  // Both sides must be present: a key minted before attribution existed has no
  // creator, and `undefined === undefined` would hand it to everyone. The
  // server lists those only to `keys.manage_all`, so this is belt and braces.
  const mayRevoke = (key: KeyWithCreator) =>
    manageAll || (manageOwn && userId !== undefined && key.createdBy === userId);

  return {
    mayList: manageOwn,
    mayRevoke,
    mayRevokeAny: (keys) => keys.some(mayRevoke),
  };
}
