import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import {
  MEMBER_CREDENTIAL_MAX_AGE_MS,
  _resetS3CredentialsCacheForTesting,
  deleteMemberS3Credentials,
  evictMemberS3Credentials,
  getConsoleS3Credentials,
  getMemberS3Credentials,
  memberConsoleKeyName,
} from './s3-credentials.ts';

const ssmMock = mockClient(SSMClient);

const ref = {
  orchestratorId: 'forge',
  stage: 'test',
  tenantId: 'tenant-1',
  userId: 'user-1',
};
const MEMBER_PATH = '/filone/test/forge-s3/member-key/tenant-1/user-1';
const TENANT_PATH = '/filone/test/forge-s3/access-key/tenant-1';

const creds = (id: string) => ({ accessKeyId: id, secretAccessKey: `secret-${id}` });

/** A ParameterNotFound the SDK's error shape matches. */
const notFound = Object.assign(new Error('not found'), { name: 'ParameterNotFound' });

beforeEach(() => {
  ssmMock.reset();
  _resetS3CredentialsCacheForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('memberConsoleKeyName', () => {
  it('names the key after the member, so it is unique across the tenant', () => {
    expect(memberConsoleKeyName('user-1')).toBe('filone-console/user-1');
  });
});

describe('getMemberS3Credentials', () => {
  it('returns the stored credential without minting', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: MEMBER_PATH })
      .resolves({ Parameter: { Value: JSON.stringify(creds('AKSTORED')) } });
    const mint = vi.fn();

    await expect(getMemberS3Credentials({ ...ref, mint })).resolves.toStrictEqual(
      creds('AKSTORED'),
    );
    expect(mint).not.toHaveBeenCalled();
  });

  it('serves the second read from cache', async () => {
    ssmMock
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: JSON.stringify(creds('AKSTORED')) } });
    const mint = vi.fn();

    await getMemberS3Credentials({ ...ref, mint });
    await getMemberS3Credentials({ ...ref, mint });

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  it('mints and stores the credential as a SecureString when none exists', async () => {
    ssmMock.on(GetParameterCommand).rejects(notFound);
    ssmMock.on(PutParameterCommand).resolves({});
    const mint = vi.fn().mockResolvedValue(creds('AKNEW'));

    await expect(getMemberS3Credentials({ ...ref, mint })).resolves.toStrictEqual(creds('AKNEW'));

    expect(mint).toHaveBeenCalledTimes(1);
    const [put] = ssmMock.commandCalls(PutParameterCommand);
    expect(put!.args[0]!.input).toStrictEqual({
      Name: MEMBER_PATH,
      Value: JSON.stringify(creds('AKNEW')),
      Type: 'SecureString',
      Overwrite: true,
    });
  });

  it('mints once for two concurrent requests from the same member', async () => {
    ssmMock.on(GetParameterCommand).rejects(notFound);
    ssmMock.on(PutParameterCommand).resolves({});
    const mint = vi.fn().mockResolvedValue(creds('AKNEW'));

    const [a, b] = await Promise.all([
      getMemberS3Credentials({ ...ref, mint }),
      getMemberS3Credentials({ ...ref, mint }),
    ]);

    expect(mint).toHaveBeenCalledTimes(1);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(1);
    expect(a).toStrictEqual(b);
  });

  it('mints separately for two different members', async () => {
    ssmMock.on(GetParameterCommand).rejects(notFound);
    ssmMock.on(PutParameterCommand).resolves({});
    const mint = vi.fn().mockResolvedValue(creds('AKNEW'));

    await Promise.all([
      getMemberS3Credentials({ ...ref, mint }),
      getMemberS3Credentials({ ...ref, userId: 'user-2', mint }),
    ]);

    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('retries a throttled write rather than losing the minted key', async () => {
    ssmMock.on(GetParameterCommand).rejects(notFound);
    const throttled = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    ssmMock.on(PutParameterCommand).rejectsOnce(throttled).rejectsOnce(throttled).resolves({});
    const mint = vi.fn().mockResolvedValue(creds('AKNEW'));

    await expect(getMemberS3Credentials({ ...ref, mint })).resolves.toStrictEqual(creds('AKNEW'));
    expect(mint).toHaveBeenCalledTimes(1);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(3);
  });

  it('rejects and caches nothing when the write fails for good', async () => {
    ssmMock.on(GetParameterCommand).rejects(notFound);
    ssmMock.on(PutParameterCommand).rejects(new Error('denied'));
    const mint = vi.fn().mockResolvedValue(creds('AKNEW'));

    await expect(getMemberS3Credentials({ ...ref, mint })).rejects.toThrow('denied');

    // The in-flight entry is released, so a later call retries rather than
    // returning the dead promise.
    ssmMock.on(PutParameterCommand).resolves({});
    await expect(getMemberS3Credentials({ ...ref, mint })).resolves.toStrictEqual(creds('AKNEW'));
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('re-reads once the cached credential passes its maximum age', async () => {
    vi.useFakeTimers();
    ssmMock
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: JSON.stringify(creds('AKSTORED')) } });
    const mint = vi.fn();

    await getMemberS3Credentials({ ...ref, mint });
    vi.advanceTimersByTime(MEMBER_CREDENTIAL_MAX_AGE_MS + 1);
    await getMemberS3Credentials({ ...ref, mint });

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  it('leaves the tenant credential in the same cache unexpired', async () => {
    vi.useFakeTimers();
    ssmMock
      .on(GetParameterCommand, { Name: TENANT_PATH })
      .resolves({ Parameter: { Value: JSON.stringify(creds('AKTENANT')) } });
    ssmMock
      .on(GetParameterCommand, { Name: MEMBER_PATH })
      .resolves({ Parameter: { Value: JSON.stringify(creds('AKMEMBER')) } });

    await getConsoleS3Credentials(ref);
    await getMemberS3Credentials({ ...ref, mint: vi.fn() });
    vi.advanceTimersByTime(MEMBER_CREDENTIAL_MAX_AGE_MS + 1);
    await getConsoleS3Credentials(ref);

    expect(ssmMock.commandCalls(GetParameterCommand, { Name: TENANT_PATH })).toHaveLength(1);
  });

  it('forwards the caller signal to the read but never to the mint', async () => {
    const controller = new AbortController();
    ssmMock.on(GetParameterCommand).rejects(notFound);
    ssmMock.on(PutParameterCommand).resolves({});
    const mint = vi.fn().mockResolvedValue(creds('AKNEW'));

    await getMemberS3Credentials({ ...ref, mint }, { signal: controller.signal });

    // A request abandoned mid-mint must not leave a key whose secret is lost.
    expect(mint).toHaveBeenCalledWith();
  });
});

describe('evictMemberS3Credentials', () => {
  it('drops only the named member', async () => {
    ssmMock
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: JSON.stringify(creds('AKSTORED')) } });
    const mint = vi.fn();

    await getMemberS3Credentials({ ...ref, mint });
    await getMemberS3Credentials({ ...ref, userId: 'user-2', mint });
    evictMemberS3Credentials(ref);
    await getMemberS3Credentials({ ...ref, mint });
    await getMemberS3Credentials({ ...ref, userId: 'user-2', mint });

    // user-1 read twice, user-2 once.
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(3);
  });
});

describe('deleteMemberS3Credentials', () => {
  it('removes the parameter and the cached entry', async () => {
    ssmMock
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: JSON.stringify(creds('AKSTORED')) } });
    ssmMock.on(DeleteParameterCommand).resolves({});

    await getMemberS3Credentials({ ...ref, mint: vi.fn() });
    await deleteMemberS3Credentials(ref);

    const [del] = ssmMock.commandCalls(DeleteParameterCommand);
    expect(del!.args[0]!.input).toStrictEqual({ Name: MEMBER_PATH });
    await getMemberS3Credentials({ ...ref, mint: vi.fn() });
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  it('treats an already-absent parameter as done', async () => {
    ssmMock.on(DeleteParameterCommand).rejects(notFound);
    await expect(deleteMemberS3Credentials(ref)).resolves.toBeUndefined();
  });
});
