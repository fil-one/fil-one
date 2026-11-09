import { Resource } from 'sst';
import { takeHourlyAllowance } from './hourly-allowance.ts';

/**
 * How many image upload URLs one limit allows in an hour. Far above anyone
 * choosing a picture (a few tries, a change of mind), and low enough that the
 * public image buckets are not free hosting for whoever loops the endpoint.
 */
export const IMAGE_UPLOAD_PRESIGNS_PER_HOUR = 30;

/** Spend one of the org's logo upload URLs for the hour, or refuse. */
export async function takeOrgLogoPresign(orgId: string, now?: Date): Promise<boolean> {
  const allowance = await takeHourlyAllowance({
    tableName: Resource.OrgTable.name,
    key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'LOGO_UPLOAD_RATE' } },
    max: IMAGE_UPLOAD_PRESIGNS_PER_HOUR,
    now,
  });
  return allowance.allowed;
}

/** Spend one of the user's avatar upload URLs for the hour, or refuse. */
export async function takeAvatarPresign(userId: string, now?: Date): Promise<boolean> {
  const allowance = await takeHourlyAllowance({
    tableName: Resource.UserInfoTable.name,
    key: { pk: { S: `USER#${userId}` }, sk: { S: 'AVATAR_UPLOAD_RATE' } },
    max: IMAGE_UPLOAD_PRESIGNS_PER_HOUR,
    now,
  });
  return allowance.allowed;
}
