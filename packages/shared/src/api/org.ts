import { z } from 'zod';

export enum OrgRole {
  Admin = 'admin',
  Member = 'member',
}

export const ORG_NAME_MIN_LENGTH = 2;
export const ORG_NAME_MAX_LENGTH = 100;

export const OrgNameSchema = z
  .string()
  .trim()
  .min(ORG_NAME_MIN_LENGTH, `Organization name must be at least ${ORG_NAME_MIN_LENGTH} characters`)
  .max(ORG_NAME_MAX_LENGTH, `Organization name must be at most ${ORG_NAME_MAX_LENGTH} characters`);

export const ConfirmOrgSchema = z.object({
  orgName: OrgNameSchema,
});
