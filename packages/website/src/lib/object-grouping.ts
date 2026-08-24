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

export function getEntriesAtPrefix(groups: VersionGroup[], prefix: string): BrowseEntry[] {
  const folders = new Set<string>();
  const files: BrowseEntry[] = [];

  for (const group of groups) {
    if (!group.key.startsWith(prefix)) continue;
    const remainder = group.key.slice(prefix.length);
    const slashIdx = remainder.indexOf('/');
    if (slashIdx === -1) {
      files.push({ kind: 'object', name: remainder, group });
    } else {
      folders.add(remainder.slice(0, slashIdx));
    }
  }

  const folderEntries: BrowseEntry[] = [...folders]
    .sort()
    .map((f) => ({ kind: 'folder', name: f, prefix: `${prefix}${f}/` }));

  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...folderEntries, ...files];
}
