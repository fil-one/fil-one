import type { S3Region } from '@filone/shared';
import { getAvailableRegions } from '@filone/shared';

export function validateRegion(region: string | undefined, stage: string): string | null {
  if (region === undefined) return null;
  const allowed = getAvailableRegions(stage);
  if (allowed.includes(region as S3Region)) return null;
  return `Unsupported region. Supported: ${allowed.join(', ')}`;
}
