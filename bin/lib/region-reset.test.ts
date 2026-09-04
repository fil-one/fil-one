import { describe, expect, it } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

// The canonical sources this file's mirrors copy. A bin script cannot import
// either at runtime — Node's type stripping resolves neither the backend's
// `./x.js` specifiers nor rag-shared's — but vitest resolves both, so the
// mirrors are held to them here rather than by hand.
import { RAGKeys } from '@filone/backend/src/lib/dynamo-records.js';
import { S3Region } from '@filone/shared';
import { S3VectorsStore } from '@filone/rag-shared/src/s3-vectors-store.js';

import {
  assertRegionAllowed,
  buildResetPlan,
  formatResetPlan,
  parseRagPk,
  ragIndexName,
  type OrgRows,
  type StoredRow,
} from './region-reset.ts';

const ORG_ID = '4f1c2a80-9b3e-4a51-8d77-6b0c2f9a1e34';
const ORG_PK = `ORG#${ORG_ID}`;
const VECTOR_BUCKET = 'filone-staging-rag-vectors';

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

function ragRow(pk: string, sk: string): StoredRow {
  return { pk: { S: pk }, sk: { S: sk } };
}

function plan(
  orgRows: Map<string, OrgRows>,
  ragRows: StoredRow[] = [],
  region = 'eu-central-3',
  orchestratorId = 'forge',
) {
  return buildResetPlan({
    stage: 'staging',
    region,
    orchestratorId,
    vectorBucket: VECTOR_BUCKET,
    orgRows,
    ragRows,
  });
}

function orgRows(rows: OrgRows): Map<string, OrgRows> {
  return new Map([[ORG_PK, rows]]);
}

describe('assertRegionAllowed', () => {
  const refusedInProduction = ['eu-west-1', 'us-east-1'];
  for (const region of refusedInProduction) {
    it(`refuses ${region} in production`, () => {
      expect(() => assertRegionAllowed('production', region)).toThrow(/production/);
    });
  }

  const pilotRegions = ['eu-central-3', 'us-east-9'];
  for (const region of pilotRegions) {
    it(`allows ${region} in production`, () => {
      expect(() => assertRegionAllowed('production', region)).not.toThrow();
    });
  }

  const allRegions = ['eu-west-1', 'us-east-1', 'eu-central-3', 'us-east-9'];
  for (const region of allRegions) {
    it(`allows ${region} on a non-production stage`, () => {
      expect(() => assertRegionAllowed('staging', region)).not.toThrow();
    });
  }

  it('refuses a region it does not know', () => {
    expect(() => assertRegionAllowed('staging', 'eu-north-7')).toThrow(/Unknown region/);
  });
});

describe('parseRagPk', () => {
  it('parses a bucket pk', () => {
    expect(parseRagPk(RAGKeys.bucketPk(ORG_ID, S3Region.EuCentral3, 'my-bucket'))).toEqual({
      kind: 'bucket',
      orgId: ORG_ID,
      region: 'eu-central-3',
      bucketName: 'my-bucket',
    });
  });

  it('parses a checkpoint pk', () => {
    expect(parseRagPk(RAGKeys.checkpointPk(ORG_ID, S3Region.EuCentral3, 'my-bucket'))).toEqual({
      kind: 'checkpoint',
      orgId: ORG_ID,
      region: 'eu-central-3',
      bucketName: 'my-bucket',
    });
  });

  const malformed: Record<string, string> = {
    'the prefix is another record': `ORG#${ORG_ID}`,
    'a segment is missing': `BUCKET#${ORG_ID}#eu-central-3`,
    'the region is unknown': `BUCKET#${ORG_ID}#eu-north-7#my-bucket`,
    'the bucket name is empty': `BUCKET#${ORG_ID}#eu-central-3#`,
  };
  for (const [description, pk] of Object.entries(malformed)) {
    it(`returns undefined when ${description}`, () => {
      expect(parseRagPk(pk)).toBeUndefined();
    });
  }
});

describe('ragIndexName', () => {
  it('names the index S3VectorsStore drops', async () => {
    let droppedIndexName: string | undefined;
    // The store reaches its client only through `send`, so a fake recording
    // one command is the whole contract.
    const store = new S3VectorsStore(VECTOR_BUCKET, {
      send: async (command: { input: { indexName?: string } }) => {
        droppedIndexName = command.input.indexName;
        return {};
      },
    } as never);

    await store.dropIndex(ORG_ID, 'eu-central-3', 'my-bucket');

    expect(droppedIndexName).toBe(ragIndexName(ORG_ID, 'eu-central-3', 'my-bucket'));
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
        ragBuckets: [],
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
    expect(result.accounts[0]!.deleting).toBe(true);
  });

  it('claims an access-key row carrying no region for eu-west-1', () => {
    const legacyKey = accessKeyRow('AKIALEGACY');
    const result = plan(
      orgRows({
        profile: profileRow({ auroraTenantId: { S: 'tenant-1' } }),
        accessKeys: [legacyKey],
      }),
      [],
      'eu-west-1',
      'aurora',
    );
    expect(result.accounts[0]!.accessKeys).toEqual([legacyKey]);
  });

  it('leaves an access-key row naming another region out of the plan', () => {
    const result = plan(
      orgRows({
        profile: profileRow({ forgeTenantId: { S: 'tenant-1' } }),
        accessKeys: [accessKeyRow('AKIAELSEWHERE', 'eu-west-1')],
      }),
    );
    expect(result.accounts[0]!.accessKeys).toEqual([]);
  });

  it('rewinds the Aurora setup status and drops its failure count', () => {
    const result = plan(
      orgRows({
        profile: profileRow({
          auroraTenantId: { S: 'tenant-1' },
          auroraSetupStatus: { S: 'FILONE_TENANT_CREATED' },
          auroraSetupFailureCount: { N: '3' },
        }),
        accessKeys: [],
      }),
      [],
      'eu-west-1',
      'aurora',
    );
    expect(result.accounts[0]!.profileAttributes).toEqual({
      auroraTenantId: 'tenant-1',
      auroraSetupStatus: 'FILONE_TENANT_CREATED',
      auroraSetupFailureCount: '3',
    });
  });

  it('names both Aurora SSM parameters for eu-west-1', () => {
    const result = plan(
      orgRows({ profile: profileRow({ auroraTenantId: { S: 'tenant-1' } }), accessKeys: [] }),
      [],
      'eu-west-1',
      'aurora',
    );
    expect(result.accounts[0]!.ssmParameterNames).toEqual([
      '/filone/staging/aurora-s3/access-key/tenant-1',
      '/filone/staging/aurora-portal/tenant-api-key/tenant-1',
    ]);
  });

  it('groups a bucket enablement, manifest and checkpoint row under one entry', () => {
    const bucketPk = RAGKeys.bucketPk(ORG_ID, S3Region.EuCentral3, 'my-bucket');
    const checkpointPk = RAGKeys.checkpointPk(ORG_ID, S3Region.EuCentral3, 'my-bucket');
    const rows = [
      ragRow(bucketPk, RAGKeys.enablementSk()),
      ragRow(bucketPk, RAGKeys.manifestSk('reports/q3.pdf')),
      ragRow(checkpointPk, RAGKeys.checkpointSk()),
    ];

    const result = plan(
      orgRows({ profile: profileRow({ forgeTenantId: { S: 'tenant-1' } }), accessKeys: [] }),
      rows,
    );

    expect(result.accounts[0]!.ragBuckets).toEqual([
      {
        bucketName: 'my-bucket',
        indexName: ragIndexName(ORG_ID, 'eu-central-3', 'my-bucket'),
        rows,
      },
    ]);
  });

  it('leaves RAG rows naming another region out of the plan', () => {
    const result = plan(
      orgRows({ profile: profileRow({ forgeTenantId: { S: 'tenant-1' } }), accessKeys: [] }),
      [ragRow(RAGKeys.bucketPk(ORG_ID, S3Region.EuWest1, 'my-bucket'), RAGKeys.enablementSk())],
    );
    expect(result.accounts[0]!.ragBuckets).toEqual([]);
  });

  it('plans the dangling RAG rows of an account holding no tenant id', () => {
    const result = plan(orgRows({ profile: profileRow(), accessKeys: [] }), [
      ragRow(RAGKeys.bucketPk(ORG_ID, S3Region.EuCentral3, 'my-bucket'), RAGKeys.enablementSk()),
    ]);
    expect({
      accounts: result.accounts.length,
      tenantId: result.accounts[0]!.tenantId,
      buckets: result.accounts[0]!.ragBuckets.map((bucket) => bucket.bucketName),
      notProvisioned: result.notProvisioned,
    }).toEqual({ accounts: 1, tenantId: undefined, buckets: ['my-bucket'], notProvisioned: 0 });
  });

  it('plans RAG rows whose account has no row in UserInfoTable', () => {
    const result = plan(new Map(), [
      ragRow(RAGKeys.bucketPk(ORG_ID, S3Region.EuCentral3, 'my-bucket'), RAGKeys.enablementSk()),
    ]);
    expect(result.accounts.map((account) => account.orgPk)).toEqual([ORG_PK]);
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
