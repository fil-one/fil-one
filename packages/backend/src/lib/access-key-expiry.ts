// The expiry a key is created with, in the two shapes it takes: the bare
// `YYYY-MM-DD` the console sends, and the RFC 3339 instant the storage system
// takes.

/** A bare calendar date, the shape the create route accepts and stores. */
export const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant a key's expiry means, for the storage system's create request.
 *
 * The console sends a bare `YYYY-MM-DD`, and the key works through the whole of
 * that day (UTC), so the instant is the start of the next one: the same rule
 * `isAccessKeyExpired` reads the stored value by, so the table and the storage
 * system stop honouring the key together. The storage system decodes the field
 * as a timestamp and refuses a bare date outright. A value that already is a
 * timestamp passes through unchanged, and no expiry stays `null`.
 */
export function toAccessKeyExpiryInstant(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  if (!BARE_DATE.test(expiresAt)) return expiresAt;
  const expiry = new Date(expiresAt);
  expiry.setUTCDate(expiry.getUTCDate() + 1);
  return expiry.toISOString();
}
