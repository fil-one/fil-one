// Version numbers in the console access key's name, for ../forge-console-key.ts.
// Tenant setup creates `filone-console`, version 1; each rotation creates
// `filone-console-v<N+1>` beside the version N the console signs with, and a
// prune deletes version N-1. The Management API cannot update a key and key
// names are unique within a tenant, so the version is what lets a new key
// stand beside the old one.

import { CONSOLE_KEY_NAME } from '@filone/backend/src/lib/orchestrator/tenant-setup.ts';

/** The fields of a Management API access key the version logic reads. */
export interface NamedAccessKey {
  type: string;
  name: string;
  accessKeyId: string;
}

const VERSIONED_NAME = new RegExp(`^${CONSOLE_KEY_NAME}-v([1-9][0-9]*)$`);

/**
 * The version a console key name carries, or undefined for any other name.
 * Version 1 has no suffix, so `filone-console-v1` is not a console key name.
 */
export function getConsoleKeyVersion(name: string): number | undefined {
  if (name === CONSOLE_KEY_NAME) return 1;
  const match = VERSIONED_NAME.exec(name);
  if (!match) return undefined;
  const version = Number(match[1]);
  return version >= 2 ? version : undefined;
}

export function getConsoleKeyName(version: number): string {
  return version === 1 ? CONSOLE_KEY_NAME : `${CONSOLE_KEY_NAME}-v${version}`;
}

/**
 * The version the next rotation creates: one above the key the console signs
 * with. With no such key, the tenant is treated as being on version 1.
 * Throws when the console signs with a key whose name carries no version.
 */
export function getNextConsoleKeyVersion(currentKeyName: string | undefined): number {
  if (currentKeyName === undefined) return 2;
  const version = getConsoleKeyVersion(currentKeyName);
  if (version === undefined) {
    throw new Error(
      `the console signs with "${currentKeyName}", which is not a ${CONSOLE_KEY_NAME} key name.`,
    );
  }
  return version + 1;
}

/**
 * The service keys with a console key name below `version`. A prune deletes
 * only version N-1, so a rotation that left any of these behind would orphan
 * them.
 */
export function findOlderConsoleKeys<K extends NamedAccessKey>(
  keys: readonly K[],
  version: number,
): K[] {
  return keys.filter((k) => {
    const v = k.type === 'service' ? getConsoleKeyVersion(k.name) : undefined;
    return v !== undefined && v < version;
  });
}

/** The service key a prune deletes: version N-1 of the console's version N key. */
export function findPrunableConsoleKey<K extends NamedAccessKey>(
  keys: readonly K[],
  currentKeyName: string,
): K | undefined {
  const version = getConsoleKeyVersion(currentKeyName);
  if (version === undefined || version === 1) return undefined;
  const previousName = getConsoleKeyName(version - 1);
  return keys.find((k) => k.type === 'service' && k.name === previousName);
}
