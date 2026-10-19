// The expiry a key is created with, in the two shapes it takes: the bare
// `YYYY-MM-DD` the console sends, and the RFC 3339 instant the storage system
// takes.

import { AccessKeyValidationError } from './errors.ts';

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
  // The request schema checks only the shape, so a date that does not exist
  // gets this far. A 13th month parses as an invalid date; a 30th of February
  // parses as the 2nd of March, so the round trip is what catches it. The
  // storage system would have refused either as a 400, and the caller maps a
  // validation error to the same response, so the refusal keeps its shape.
  if (Number.isNaN(expiry.getTime()) || expiry.toISOString().slice(0, 10) !== expiresAt) {
    throw new AccessKeyValidationError(`expiresAt "${expiresAt}" is not a calendar date.`);
  }
  expiry.setUTCDate(expiry.getUTCDate() + 1);
  return expiry.toISOString();
}
