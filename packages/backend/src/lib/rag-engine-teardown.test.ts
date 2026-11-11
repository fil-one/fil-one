import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3Region } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: { RagIndexerTable: { name: 'RagIndexerTable' } },
}));

const mockGetOrchestratorForRegion = vi.fn();
vi.mock('./service-orchestrator-registry.ts', () => ({
  getOrchestratorForRegion: (...args: unknown[]) => mockGetOrchestratorForRegion(...args),
}));

let engine: FakeRagEngine = fakeRagEngine();
let engineConfigured = true;
vi.mock('./rag-engine-client.ts', async () => {
  const actual =
    await vi.importActual<typeof import('./rag-engine-client.ts')>('./rag-engine-client.ts');
  return {
    ...actual,
    getRagEngineConfig: () =>
      engineConfigured ? { baseUrl: 'https://engine.test.invalid', token: 't' } : undefined,
    getRagEngineClient: (config?: unknown) => {
      if (!engineConfigured || !config) throw new actual.RagEngineNotConfiguredError();
      return engine;
    },
  };
});

const ddbMock = mockClient(DynamoDBClient);

import { DROP_CONCURRENCY, dropRagEngineDatasets } from './rag-engine-teardown.ts';
import { fakeOrchestrator } from '../test/fake-orchestrator.ts';
import { expectedTarget, fakeRagEngine, type FakeRagEngine } from '../test/fake-rag-engine.ts';
import { RagEngineRequestError } from './rag-engine-client.ts';

const ORG = 'org-1';
const TENANTS = { forge: 'forge:org-1', forgeDev: 'forgeDev:org-1', aurora: 'aurora:org-1' };

function rows(...pks: string[]) {
  ddbMock.on(ScanCommand).resolves({ Items: pks.map((pk) => marshall({ pk })) });
}

describe('dropRagEngineDatasets', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    engine = fakeRagEngine();
    engineConfigured = true;
    const orchestrators = {
      [S3Region.EuCentral3]: fakeOrchestrator('forge', { region: S3Region.EuCentral3 }),
      [S3Region.UsEast9]: fakeOrchestrator('forgeDev', { region: S3Region.UsEast9 }),
      [S3Region.EuWest1]: fakeOrchestrator('aurora', { region: S3Region.EuWest1 }),
    };
    mockGetOrchestratorForRegion.mockImplementation(
      (region: keyof typeof orchestrators) => orchestrators[region],
    );
  });

  it('drops each Forge-region dataset with the tenant target, and nothing else', async () => {
    rows(
      `BUCKET#${ORG}#${S3Region.EuCentral3}#docs`,
      `BUCKET#${ORG}#${S3Region.UsEast9}#notes`,
      `BUCKET#${ORG}#${S3Region.EuWest1}#legacy`,
    );

    await dropRagEngineDatasets(ORG, TENANTS);

    expect(engine.drop.mock.calls.map(([target]) => target)).toStrictEqual([
      expectedTarget('forge', S3Region.EuCentral3, 'docs'),
      expectedTarget('forgeDev', S3Region.UsEast9, 'notes'),
    ]);
  });

  it('scans only this org’s enablement rows', async () => {
    rows();

    await dropRagEngineDatasets(ORG, TENANTS);

    const scan = ddbMock.commandCalls(ScanCommand)[0]!.args[0].input;
    expect(scan.TableName).toBe('RagIndexerTable');
    expect(scan.ExpressionAttributeValues).toEqual(
      marshall({ ':bucket': `BUCKET#${ORG}#`, ':sk': 'RAG' }),
    );
  });

  it('skips a region the org has no tenant in', async () => {
    rows(`BUCKET#${ORG}#${S3Region.EuCentral3}#docs`);

    await dropRagEngineDatasets(ORG, { aurora: 'aurora:org-1' });

    expect(engine.drop).not.toHaveBeenCalled();
  });

  it('keeps going past a failed drop and never throws', async () => {
    rows(`BUCKET#${ORG}#${S3Region.EuCentral3}#a`, `BUCKET#${ORG}#${S3Region.EuCentral3}#b`);
    engine.drop.mockRejectedValueOnce(new RagEngineRequestError('down'));

    await expect(dropRagEngineDatasets(ORG, TENANTS)).resolves.toBeUndefined();

    expect(engine.drop).toHaveBeenCalledTimes(2);
  });

  it('runs drops concurrently, at most DROP_CONCURRENCY at a time', async () => {
    const names = Array.from({ length: DROP_CONCURRENCY + 4 }, (_, i) => `b${i}`);
    rows(...names.map((name) => `BUCKET#${ORG}#${S3Region.EuCentral3}#${name}`));
    let inFlight = 0;
    let peak = 0;
    engine.drop.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });

    await dropRagEngineDatasets(ORG, TENANTS);

    expect(engine.drop).toHaveBeenCalledTimes(names.length);
    expect(peak).toBe(DROP_CONCURRENCY);
  });

  it('leaves the datasets to tenant deletion when the stage has no engine', async () => {
    engineConfigured = false;
    rows(`BUCKET#${ORG}#${S3Region.EuCentral3}#docs`);

    await expect(dropRagEngineDatasets(ORG, TENANTS)).resolves.toBeUndefined();
  });

  it('does no Scan on a stage with no engine (production)', async () => {
    engineConfigured = false;
    rows(`BUCKET#${ORG}#${S3Region.EuCentral3}#docs`);

    await dropRagEngineDatasets(ORG, TENANTS);

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    expect(engine.drop).not.toHaveBeenCalled();
  });

  it('never throws when the Scan fails', async () => {
    ddbMock.on(ScanCommand).rejects(new Error('throttled'));

    await expect(dropRagEngineDatasets(ORG, TENANTS)).resolves.toBeUndefined();
    expect(engine.drop).not.toHaveBeenCalled();
  });
});
