import type { S3Region } from '@filone/shared';
import { formatRegion, getAvailableRegions } from '@filone/shared';

import { FILONE_STAGE } from '../env.js';
import { Select } from './Select';

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
    <Select
      id={id}
      value={value}
      onChange={(v) => onChange(v as S3Region)}
      disabled={disabled || onlyOne}
    >
      {regions.map((region) => (
        <option key={region} value={region}>
          {formatRegion(region)}
        </option>
      ))}
    </Select>
  );
}
