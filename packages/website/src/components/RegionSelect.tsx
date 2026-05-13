import type { S3Region } from '@filone/shared';
import { formatRegion, getAvailableRegions } from '@filone/shared';

import { FILONE_STAGE } from '../env.js';

type RegionSelectProps = {
  id?: string;
  value: S3Region;
  onChange: (region: S3Region) => void;
  disabled?: boolean;
};

export function RegionSelect({ id, value, onChange, disabled }: RegionSelectProps) {
  const regions = getAvailableRegions(FILONE_STAGE);
  const onlyOne = regions.length === 1;

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as S3Region)}
      disabled={disabled || onlyOne}
      className="block w-full rounded-md border border-zinc-200 bg-white px-3 py-2.5 text-[13px] text-zinc-900 focus:outline-2 focus:outline-brand-600 disabled:bg-zinc-50 disabled:opacity-50"
    >
      {regions.map((region) => (
        <option key={region} value={region}>
          {formatRegion(region)}
        </option>
      ))}
    </select>
  );
}
