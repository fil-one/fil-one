import { describe, expect, it } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

import {
  assertRegionAllowed,
  buildResetPlan,
  formatResetPlan,
  type OrgRows,
  type StoredRow,
} from './region-reset.ts';

const ORG_ID = '4f1c2a80-9b3e-4a51-8d77-6b0c2f9a1e34';
const ORG_PK = `ORG#${ORG_ID}`;

function profileRow(attributes: Record<string, AttributeValue> = {}): StoredRow {
  return { pk: { S: ORG_PK }, sk: { S: 'PROFILE' }, ...attributes };
}

function accessKeyRow(keyId: string, region?: string): StoredRow {
  return {
    pk: { S: ORG_PK },
    sk: { S: `ACCESSKEY#${keyId}` },
    accessKeyId: { S: keyId },
    ...(region ? { region: { S: region } } : {}),
  };
}

function plan(orgRows: Map<string, OrgRows>, region = 'eu-central-3', orchestratorId = 'forge') {
  return buildResetPlan({ stage: 'staging', region, orchestratorId, orgRows });
}

function orgRows(rows: OrgRows): Map<string, OrgRows> {
  return new Map([[ORG_PK, rows]]);
}

describe('assertRegionAllowed', () => {
  const allRegions = ['eu-west-1', 'us-east-1', 'eu-central-3', 'us-east-9'];
  for (const region of allRegions) {
    it(`refuses ${region} in production`, () => {
      expect(() => assertRegionAllowed('production', region)).toThrow(/production/);
    });
  }

  for (const region of allRegions) {
    it(`allows ${region} on a non-production stage`, () => {
      expect(() => assertRegionAllowed('staging', region)).not.toThrow();
    });
  }

  it('refuses a region it does not know', () => {
    expect(() => assertRegionAllowed('staging', 'eu-north-7')).toThrow(/Unknown region/);
  });
});

describe('buildResetPlan', () => {
  it('counts an account with no tenant id as not provisioned', () => {
    const result = plan(orgRows({ profile: profileRow(), accessKeys: [] }));
    expect({ accounts: result.accounts, notProvisioned: result.notProvisioned }).toEqual({
      accounts: [],
      notProvisioned: 1,
    });
  });

  it('plans the account holding the tenant id', () => {
    const result = plan(
      orgRows({ profile: profileRow({ forgeTenantId: { S: 'tenant-1' } }), accessKeys: [] }),
    );
    expect(result.accounts).toEqual([
      {
        orgPk: ORG_PK,
        orgId: ORG_ID,
        tenantId: 'tenant-1',
        deleting: false,
        profileAttributes: { forgeTenantId: 'tenant-1' },
        accessKeys: [],
        ssmParameterNames: ['/filone/staging/forge-s3/access-key/tenant-1'],
      },
    ]);
  });

  it('carries the deleting flag onto the entry', () => {
    const result = plan(
      orgRows({
        profile: profileRow({ forgeTenantId: { S: 'tenant-1' }, deleting: { BOOL: true } }),
        accessKeys: [],
      }),
    );
    expect(result.accounts[0]).toHaveProperty('deleting', true);
  });

  it('claims an access-key row carrying no region for eu-west-1', () => {
    const legacyKey = accessKeyRow('AKIALEGACY');
    const result = plan(
      orgRows({
        profile: profileRow({ auroraTenantId: { S: 'tenant-1' } }),
        accessKeys: [legacyKey],
      }),
      'eu-west-1',
      'aurora',
    );
    expect(result.accounts[0]).toHaveProperty('accessKeys', [legacyKey]);
  });

  it('leaves an access-key row naming another region out of the plan', () => {
    const result = plan(
      orgRows({
        profile: profileRow({ forgeTenantId: { S: 'tenant-1' } }),
        accessKeys: [accessKeyRow('AKIAELSEWHERE', 'eu-west-1')],
      }),
    );
    expect(result.accounts[0]).toHaveProperty('accessKeys', []);
  });

  it('records the prior Aurora setup status and failure count', () => {
    const result = plan(
      orgRows({
        profile: profileRow({
          auroraTenantId: { S: 'tenant-1' },
          auroraSetupStatus: { S: 'FILONE_TENANT_CREATED' },
          auroraSetupFailureCount: { N: '3' },
        }),
        accessKeys: [],
      }),
      'eu-west-1',
      'aurora',
    );
    expect(result.accounts[0]).toHaveProperty('profileAttributes', {
      auroraTenantId: 'tenant-1',
      auroraSetupStatus: 'FILONE_TENANT_CREATED',
      auroraSetupFailureCount: '3',
    });
  });

  it('names both Aurora SSM parameters for eu-west-1', () => {
    const result = plan(
      orgRows({ profile: profileRow({ auroraTenantId: { S: 'tenant-1' } }), accessKeys: [] }),
      'eu-west-1',
      'aurora',
    );
    expect(result.accounts[0]).toHaveProperty('ssmParameterNames', [
      '/filone/staging/aurora-s3/access-key/tenant-1',
      '/filone/staging/aurora-portal/tenant-api-key/tenant-1',
    ]);
  });

  it('plans the dangling access keys of an account holding no tenant id', () => {
    const strayKey = accessKeyRow('AKIASTRAY', 'eu-central-3');
    const result = plan(orgRows({ profile: profileRow(), accessKeys: [strayKey] }));
    expect({
      accounts: result.accounts.length,
      tenantId: result.accounts[0]!.tenantId,
      accessKeys: result.accounts[0]!.accessKeys,
      ssmParameterNames: result.accounts[0]!.ssmParameterNames,
      notProvisioned: result.notProvisioned,
    }).toEqual({
      accounts: 1,
      tenantId: undefined,
      accessKeys: [strayKey],
      ssmParameterNames: [],
      notProvisioned: 0,
    });
  });

  it("counts an account holding only another region's keys as not provisioned", () => {
    const result = plan(
      orgRows({ profile: profileRow(), accessKeys: [accessKeyRow('AKIAELSEWHERE', 'eu-west-1')] }),
    );
    expect({ accounts: result.accounts, notProvisioned: result.notProvisioned }).toEqual({
      accounts: [],
      notProvisioned: 1,
    });
  });
});

describe('formatResetPlan', () => {
  it('marks an account being torn down', () => {
    const result = plan(
      orgRows({
        profile: profileRow({ forgeTenantId: { S: 'tenant-1' }, deleting: { BOOL: true } }),
        accessKeys: [],
      }),
    );
    expect(formatResetPlan(result)[0]).toContain('[account deletion in progress]');
  });
});
