import { randomBytes } from 'node:crypto';
import { KEY_NAME_MAX_LENGTH } from '@filone/shared';

/**
 * Characters of randomness in the suffix. Six hex is 24 bits, which is far more
 * than a tenant's handful of keys needs to avoid a collision and short enough
 * that it costs almost nothing from the name budget.
 */
const SUFFIX_ENTROPY_BYTES = 3;

/** `.r` plus the hex — the whole of what a rotation adds to a name. */
const SUFFIX_LENGTH = 2 + SUFFIX_ENTROPY_BYTES * 2;

/**
 * The name a rotation's replacement is minted under at the vendor.
 *
 * A key name is unique within a tenant and no orchestrator can rename one, so
 * the replacement cannot take the console name while the key it replaces is
 * still holding it. It takes a suffixed one instead, and the row keeps showing
 * what its owner called it.
 *
 * The suffix is random rather than a counter for the reason `bin/fth-console-key.ts`
 * records from a production failure: a vendor can answer a create with a 201 and
 * hold no key, and a deterministic name then collides forever with whatever that
 * attempt left behind. A fresh name per attempt cannot.
 *
 * The result stays inside `KEY_NAME_PATTERN`, which allows the period, and
 * inside `KEY_NAME_MAX_LENGTH`, trimming the base name when it would not
 * otherwise fit. A name that has already been rotated is trimmed like any
 * other, so suffixes do not accumulate.
 */
export function vendorNameForRotation(keyName: string): string {
  const suffix = `.r${randomBytes(SUFFIX_ENTROPY_BYTES).toString('hex')}`;
  const base = keyName.slice(0, KEY_NAME_MAX_LENGTH - SUFFIX_LENGTH);
  // A base ending in a trailing space would make the vendor name and the
  // console name differ by whitespace nobody can see.
  return `${base.trimEnd()}${suffix}`;
}
