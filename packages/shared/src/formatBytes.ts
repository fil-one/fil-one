const SIZES = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const SHORT_SIZES = ['B', 'K', 'M', 'G', 'T'] as const;
const K = 1000;

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(K));
  return `${parseFloat((bytes / Math.pow(K, i)).toFixed(1))} ${SIZES[i]}`;
}

export function formatBytesShort(bytes: number): string {
  if (bytes === 0) return '0';
  const i = Math.floor(Math.log(bytes) / Math.log(K));
  return `${parseFloat((bytes / Math.pow(K, i)).toFixed(0))}${SHORT_SIZES[i]}`;
}

/**
 * Build a byte formatter that renders every value in one fixed unit.
 *
 * `formatBytesShort` picks a unit per value, which is wrong for an axis: on a
 * 0 → 2 MB scale it labels the ticks `0 · 500K · 1M · 2M · 2M`, mixing
 * magnitudes between neighbours and repeating `2M` for 1.5 MB and 2 MB. Ticks
 * are read against each other, so they need a shared unit, taken here from the
 * top of the domain, and a decimal place when the step lands between whole
 * units.
 */
export function bytesAxisFormatter(domainMax: number): (bytes: number) => string {
  const i =
    domainMax > 0 ? Math.min(Math.floor(Math.log(domainMax) / Math.log(K)), SIZES.length - 1) : 0;
  const divisor = Math.pow(K, i);
  const unit = SHORT_SIZES[i];
  return (bytes: number) => {
    if (bytes === 0) return '0';
    const scaled = bytes / divisor;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}${unit}`;
  };
}
