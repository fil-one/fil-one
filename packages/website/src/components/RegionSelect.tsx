import type { S3Region } from '@filone/shared';
import { formatRegion } from '@filone/shared';

import { useAvailableRegions } from '../lib/use-available-regions.js';
import { Select } from './Select';

type RegionSelectProps = {
  id?: string;
  value: S3Region;
  onChange: (region: S3Region) => void;
  disabled?: boolean;
};

export function RegionSelect({ id, value, onChange, disabled }: RegionSelectProps) {
  const regions = useAvailableRegions();
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
