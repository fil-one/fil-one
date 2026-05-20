export const FthTenantSetupStatus = {
  FTH_CLIENT_CREATED: 'FTH_CLIENT_CREATED',
  FTH_STORAGE_USER_CREATED: 'FTH_STORAGE_USER_CREATED',
  FTH_S3_ACCESS_KEY_CREATED: 'FTH_S3_ACCESS_KEY_CREATED',
} as const;

export const FTH_TENANT_FINAL_SETUP_STATUS = FthTenantSetupStatus.FTH_S3_ACCESS_KEY_CREATED;

export function isFthTenantSetupComplete(status: string | undefined): boolean {
  return status === FTH_TENANT_FINAL_SETUP_STATUS;
}
