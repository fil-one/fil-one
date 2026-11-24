import type { S3ObjectVersion } from '@filone/shared';

export interface VersionGroup {
  key: string;
  latest: S3ObjectVersion;
  versions: S3ObjectVersion[];
  versionCount: number;
}

export function groupVersionsByKey(versions: S3ObjectVersion[]): VersionGroup[] {
  const groups = new Map<string, S3ObjectVersion[]>();
  for (const v of versions) {
    const existing = groups.get(v.key) ?? [];
    existing.push(v);
    groups.set(v.key, existing);
  }
  return Array.from(groups.entries()).map(([key, vers]) => {
    const latest = vers.find((v) => v.isLatest) ?? vers[0];
    return { key, latest, versions: vers, versionCount: vers.length };
  });
}

/**
 * Count distinct object keys in a flat list of versions. Shares grouping logic
 * with the browser so the count always matches the rendered rows.
 */
export function countObjects(versions: S3ObjectVersion[]): number {
  return groupVersionsByKey(versions).length;
}

export type BrowseEntry =
  | { kind: 'folder'; name: string; prefix: string }
  | { kind: 'object'; name: string; group: VersionGroup };

/**
 * The rows of one listing page of a folder: its sub-folders, then its objects,
 * each sorted by name.
 *
 * A delimited listing already splits the folder's contents, so `folders` comes
 * straight from S3 and every key in `groups` sits directly under `prefix`. A key
 * equal to `prefix` is the zero-byte marker some tools write to create an empty
 * folder; it is the folder itself rather than something in it, so it gets no row.
 */
export function getEntriesAtPrefix(
  groups: VersionGroup[],
  folders: string[],
  prefix: string,
): BrowseEntry[] {
  const folderEntries: BrowseEntry[] = folders
    .map((folder) => ({
      kind: 'folder' as const,
      name: folder.slice(prefix.length, -1),
      prefix: folder,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const files: BrowseEntry[] = groups
    .filter((group) => group.key !== prefix)
    .map((group) => ({ kind: 'object' as const, name: group.key.slice(prefix.length), group }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...folderEntries, ...files];
}
