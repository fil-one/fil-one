/**
 * The canonical hyphenated form of a UUID: eight hex digits, three groups of
 * four, twelve. Case-insensitive, because the spec calls upper case valid input
 * even though every id this system mints is lower case.
 *
 * Deliberately not a version-and-variant check. The property callers need is
 * that the value is hex and hyphens and nothing else — a `#` in an org id would
 * reach a DynamoDB key expression, which is what `RAGKeys.parseBucketPk`
 * depends on not happening. A stricter regex would additionally reject ids
 * outside the v1–v8 range, and the only thing that could produce is a lockout
 * on an id some other tool minted.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string is a well-formed UUID. Anything else is a client error. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
