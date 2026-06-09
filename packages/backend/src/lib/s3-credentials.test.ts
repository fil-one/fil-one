import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssmMock = mockClient(SSMClient);

vi.mock('sst', () => ({
  Resource: {},
}));

process.env.FILONE_STAGE = 'test';

import { getConsoleS3Credentials, _resetS3CredentialsCacheForTesting } from './s3-credentials.js';

const STAGE = 'test';
const TENANT_A = 'tenant-aaa';
const TENANT_B = 'tenant-bbb';
const ORCHESTRATOR_FTH = 'fth';
const ORCHESTRATOR_AURORA = 'aurora';

const CREDS_A = { accessKeyId: 'AKA', secretAccessKey: 'SKA' };
const CREDS_B = { accessKeyId: 'AKB', secretAccessKey: 'SKB' };

function ssmResolveWith(creds: { accessKeyId: string; secretAccessKey: string }) {
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: JSON.stringify(creds) },
  });
}

beforeEach(() => {
  ssmMock.reset();
  _resetS3CredentialsCacheForTesting();
});

describe('getConsoleS3Credentials — SSM cache TTL (5 min)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns cached credentials within the TTL without calling SSM again', async () => {
    vi.useFakeTimers();
    ssmResolveWith(CREDS_A);

    await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_FTH, stage: STAGE, tenantId: TENANT_A });

    // Advance to just under the 5-minute TTL
    vi.advanceTimersByTime(4 * 60 * 1000 + 59_000);

    await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_FTH, stage: STAGE, tenantId: TENANT_A });

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  it('re-fetches from SSM after the TTL expires', async () => {
    vi.useFakeTimers();
    ssmResolveWith(CREDS_A);

    await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_FTH, stage: STAGE, tenantId: TENANT_A });

    // Advance past the 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_FTH, stage: STAGE, tenantId: TENANT_A });

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  it('caches different tenants independently', async () => {
    vi.useFakeTimers();
    ssmMock
      .on(GetParameterCommand, { Name: `/filone/${STAGE}/${ORCHESTRATOR_FTH}-s3/access-key/${TENANT_A}` })
      .resolves({ Parameter: { Value: JSON.stringify(CREDS_A) } })
      .on(GetParameterCommand, { Name: `/filone/${STAGE}/${ORCHESTRATOR_FTH}-s3/access-key/${TENANT_B}` })
      .resolves({ Parameter: { Value: JSON.stringify(CREDS_B) } });

    const resultA = await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_FTH, stage: STAGE, tenantId: TENANT_A });
    const resultB = await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_FTH, stage: STAGE, tenantId: TENANT_B });

    // Second call for each — should still be cached
    await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_FTH, stage: STAGE, tenantId: TENANT_A });
    await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_FTH, stage: STAGE, tenantId: TENANT_B });

    expect(resultA).toEqual(CREDS_A);
    expect(resultB).toEqual(CREDS_B);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  it('does not collide cache entries across different orchestratorIds for the same tenant', async () => {
    vi.useFakeTimers();
    ssmMock
      .on(GetParameterCommand, { Name: `/filone/${STAGE}/${ORCHESTRATOR_FTH}-s3/access-key/${TENANT_A}` })
      .resolves({ Parameter: { Value: JSON.stringify(CREDS_A) } })
      .on(GetParameterCommand, { Name: `/filone/${STAGE}/${ORCHESTRATOR_AURORA}-s3/access-key/${TENANT_A}` })
      .resolves({ Parameter: { Value: JSON.stringify(CREDS_B) } });

    const fthResult = await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_FTH, stage: STAGE, tenantId: TENANT_A });
    const auroraResult = await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_AURORA, stage: STAGE, tenantId: TENANT_A });

    expect(fthResult).toEqual(CREDS_A);
    expect(auroraResult).toEqual(CREDS_B);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  it('_resetS3CredentialsCacheForTesting forces a re-fetch within the TTL window', async () => {
    vi.useFakeTimers();
    ssmResolveWith(CREDS_A);

    await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_FTH, stage: STAGE, tenantId: TENANT_A });

    // Only 1 minute has elapsed — well within TTL
    vi.advanceTimersByTime(60_000);

    _resetS3CredentialsCacheForTesting();

    await getConsoleS3Credentials({ orchestratorId: ORCHESTRATOR_FTH, stage: STAGE, tenantId: TENANT_A });

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
  });
});
