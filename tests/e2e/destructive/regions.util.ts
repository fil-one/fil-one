// Kept in sync with S3Region in packages/shared/src/constants.ts — the e2e
// suite does not import workspace packages, so the region list is duplicated
// here. All four regions are selectable for all users on non-production
// stages; the Forge regions are hidden in production (see getAvailableRegions).
export const REGIONS = [
  'eu-west-1',
  'us-east-1',
  // Forge staging
  'eu-central-3',
  // Forge dev
  'us-east-9',
] as const;

export type Region = (typeof REGIONS)[number];

export function isRegion(value: string): value is Region {
  return (REGIONS as readonly string[]).includes(value);
}
