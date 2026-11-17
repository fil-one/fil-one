import type { S3Region } from '@filone/shared';
import { getRegionLabel } from '@filone/shared';

import { RegionFlag } from './RegionFlag';

/**
 * A region's flag, name and code. In a list the codes are right-aligned into a
 * column; in a closed field the code stays beside the name it belongs to.
 *
 * Shared by `RegionSelect`, which picks a region, and `NetworkRegionSelect`,
 * which picks a storage network and lists its regions, so a row reads the same
 * wherever a region is offered.
 */
export function RegionLine({
  region,
  isCodeInColumn,
}: {
  region: S3Region;
  isCodeInColumn: boolean;
}) {
  return (
    <>
      {/* The name beside the flag already says where it is, so the flag stays out of the accessible name */}
      <span aria-hidden="true" className="flex group-data-disabled:opacity-50">
        <RegionFlag region={region} />
      </span>
      <span className="truncate">{getRegionLabel(region)}</span>
      <span
        className={`shrink-0 text-zinc-500 group-data-disabled:text-zinc-400 ${isCodeInColumn ? 'ml-auto pl-3' : ''}`}
      >
        {region}
      </span>
    </>
  );
}
