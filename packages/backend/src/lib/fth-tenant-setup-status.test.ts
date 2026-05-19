import { describe, it, expect } from 'vitest';
import {
  FthTenantSetupStatus,
  FTH_TENANT_FINAL_SETUP_STATUS,
  isFthTenantSetupComplete,
} from './fth-tenant-setup-status.js';

describe('isFthTenantSetupComplete', () => {
  const cases: Record<string, { input: string | undefined; expected: boolean }> = {
    'status is the final FTH_S3_ACCESS_KEY_CREATED state': {
      input: FTH_TENANT_FINAL_SETUP_STATUS,
      expected: true,
    },
    'status is the intermediate FTH_CLIENT_CREATED state': {
      input: FthTenantSetupStatus.FTH_CLIENT_CREATED,
      expected: false,
    },
    'status is the intermediate FTH_STORAGE_USER_CREATED state': {
      input: FthTenantSetupStatus.FTH_STORAGE_USER_CREATED,
      expected: false,
    },
    'status is undefined': { input: undefined, expected: false },
    'status is an unknown string': { input: 'AURORA_S3_ACCESS_KEY_CREATED', expected: false },
    'status is empty': { input: '', expected: false },
  };

  for (const [desc, { input, expected }] of Object.entries(cases)) {
    it(`returns ${expected} when ${desc}`, () => {
      expect(isFthTenantSetupComplete(input)).toBe(expected);
    });
  }
});
