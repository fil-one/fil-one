import { describe, expect, it } from 'vitest';
import { SubscriptionStatus } from '@filone/shared';

import {
  orchestratorProcessEnv,
  orchestratorSecrets,
  summarizeOutcomes,
  unlockWarnings,
} from './tenant-unlock.ts';

// What the AccountDeletionWorker's environment holds in production: Aurora and
// FTH, and no Forge network.
const PRODUCTION_LIKE_ENV = {
  FILONE_STAGE: 'any-stage',
  AURORA_BACKOFFICE_URL: 'https://aurora.example',
  AURORA_PARTNER_ID: 'any-partner',
  FTH_MANAGEMENT_API_URL: 'https://fth.example',
  FORGE_MANAGEMENT_API_URL: '',
  FORGE_DEV_MANAGEMENT_API_URL: undefined,
};

describe('orchestratorSecrets', () => {
  it('asks only for the tokens of the orchestrators the stage runs', () => {
    expect(orchestratorSecrets(PRODUCTION_LIKE_ENV)).toStrictEqual([
      'AuroraBackofficeToken',
      'FthManagementApiToken',
    ]);
  });

  it('asks for a Forge token where the stage runs that Forge network', () => {
    expect(
      orchestratorSecrets({ ...PRODUCTION_LIKE_ENV, FORGE_DEV_MANAGEMENT_API_URL: 'https://f' }),
    ).toStrictEqual([
      'AuroraBackofficeToken',
      'FthManagementApiToken',
      'ForgeDevManagementApiToken',
    ]);
  });
});

describe('orchestratorProcessEnv', () => {
  it('carries the deployed variables and links each secret and the table as an SST resource', () => {
    expect(
      orchestratorProcessEnv({
        stage: 'any-stage',
        lambdaEnv: PRODUCTION_LIKE_ENV,
        secrets: {
          AuroraBackofficeToken: 'any-aurora-token',
          FthManagementApiToken: 'any-fth-token',
        },
        userInfoTable: 'filone-any-stage-UserInfoTable',
      }),
    ).toStrictEqual({
      FILONE_STAGE: 'any-stage',
      AURORA_BACKOFFICE_URL: 'https://aurora.example',
      AURORA_PARTNER_ID: 'any-partner',
      FTH_MANAGEMENT_API_URL: 'https://fth.example',
      SST_RESOURCE_App: JSON.stringify({ name: 'filone', stage: 'any-stage' }),
      SST_RESOURCE_UserInfoTable: JSON.stringify({ name: 'filone-any-stage-UserInfoTable' }),
      SST_RESOURCE_AuroraBackofficeToken: JSON.stringify({ value: 'any-aurora-token' }),
      SST_RESOURCE_FthManagementApiToken: JSON.stringify({ value: 'any-fth-token' }),
    });
  });
});

describe('unlockWarnings', () => {
  it.each([SubscriptionStatus.Manual, SubscriptionStatus.Active])(
    'has nothing to warn about for an org that is %s',
    (status) => {
      expect(unlockWarnings(status)).toStrictEqual([]);
    },
  );

  it.each([
    SubscriptionStatus.Trialing,
    SubscriptionStatus.GracePeriod,
    SubscriptionStatus.Canceled,
    undefined,
  ])('warns that the jobs may lock an org that is %s again', (status) => {
    expect(unlockWarnings(status)).toStrictEqual([
      `The org's billing status is ${status ?? 'unset'}, so the usage or grace-period job ` +
        'may lock its tenants again on its next run. Set the billing row first, e.g. with ' +
        'bin/set-manual-billing.ts.',
    ]);
  });
});

describe('summarizeOutcomes', () => {
  it('lists each region and fails when any region failed', () => {
    expect(
      summarizeOutcomes([
        { orchestratorId: 'aurora', tenantId: 'any-tenant-a', outcome: 'updated' },
        {
          orchestratorId: 'fth',
          tenantId: 'any-tenant-b',
          outcome: 'error',
          cause: new Error('x'),
        },
      ]),
    ).toStrictEqual({
      lines: ['  aurora  any-tenant-a  updated', '  fth  any-tenant-b  error: x'],
      failed: true,
    });
  });

  it('passes when every region is active or was made so', () => {
    expect(
      summarizeOutcomes([
        { orchestratorId: 'aurora', tenantId: 'any-tenant-a', outcome: 'in-sync' },
      ]),
    ).toMatchObject({ failed: false });
  });

  it('fails when a region reports the tenant missing, since nothing was made active there', () => {
    expect(
      summarizeOutcomes([
        { orchestratorId: 'aurora', tenantId: 'any-tenant-a', outcome: 'not-found' },
      ]),
    ).toMatchObject({ failed: true });
  });

  it('fails when the org is provisioned on no network, so nothing was unlocked', () => {
    expect(summarizeOutcomes([])).toStrictEqual({
      lines: ['  (no provisioned networks)'],
      failed: true,
    });
  });
});
