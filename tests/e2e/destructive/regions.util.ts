// Kept in sync with S3Region in packages/shared/src/constants.ts — the e2e
// suite does not import workspace packages, so the region list is duplicated
// here. In staging both regions are selectable for all users.
export const REGIONS = ['eu-west-1', 'us-east-1'] as const;

export type Region = (typeof REGIONS)[number];
