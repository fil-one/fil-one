import { stringifySearchWith } from '@tanstack/react-router';

/**
 * The router's search-string codec: every value stays the string it was in the
 * URL.
 *
 * TanStack's default turns `true`, `false` and plain numbers into booleans and
 * numbers (its own `decode` does, before any custom parser runs), so
 * `?portal_return=true` (Stripe's billing return) arrives as a boolean, and a
 * folder named `123` or a numeric version id as a number. Every route's search
 * schema expects strings, and a value of the wrong type fails validation and
 * renders the error page instead. No route here carries anything but strings,
 * so nothing is converted. A repeated key keeps its last value.
 */
export function parseSearch(searchStr: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(searchStr));
}

/**
 * The inverse of {@link parseSearch}: strings are written as they are, without
 * the quotes the default adds to a string that would parse as JSON (which
 * would otherwise turn a folder named `123` into `"123"` on the way back).
 */
export const stringifySearch = stringifySearchWith(JSON.stringify);
