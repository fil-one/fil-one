import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { ApiErrorCode } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    DeletionChallengeTable: { name: 'DeletionChallengeTable' },
  },
}));

const mockIsOrgAdmin = vi.fn(async () => true);
vi.mock('../lib/org-membership.js', () => ({ isOrgAdmin: () => mockIsOrgAdmin() }));

const mockGetOrgProfile = vi.fn(async () => ({ name: { S: 'Acme Corp' } }));
vi.mock('../lib/org-profile.js', () => ({ getOrgProfile: () => mockGetOrgProfile() }));

const mockConfirm = vi.fn();
const mockConsumeAttempt = vi.fn(async (_orgId: string) => undefined);
vi.mock('../lib/deletion-confirm-transaction.js', () => ({
  confirmAccountDeletion: (params: unknown) => mockConfirm(params),
  consumeVerifyAttempt: (orgId: string) => mockConsumeAttempt(orgId),
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './confirm-account-deletion.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

const USER_INFO = { userId: 'user-1', orgId: 'org-1', emailVerified: true };

function event(body: unknown) {
  return buildEvent({
    userInfo: USER_INFO,
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = { code: '123456', orgName: 'Acme Corp' };

describe('confirm-account-deletion', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    process.env.ACCOUNT_DELETION_ENABLED = 'true';
    mockIsOrgAdmin.mockResolvedValue(true);
    mockGetOrgProfile.mockResolvedValue({ name: { S: 'Acme Corp' } });
    mockConfirm.mockResolvedValue({ outcome: 'confirmed' });
    ddbMock.on(GetItemCommand).resolves({ Item: { salt: { S: 'deadbeef' } } });
  });

  // The route stays deployed while the feature is withheld (FIL-919), so the
  // refusal has to come from the handler — ahead of the code being spent.
  it('answers 501 without committing the deletion when the feature is off', async () => {
    process.env.ACCOUNT_DELETION_ENABLED = 'false';

    const result = await baseHandler(event(VALID));

    expect(result.statusCode).toBe(501);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('202s and commits the transaction', async () => {
    const result = await baseHandler(event(VALID));

    expect(result.statusCode).toBe(202);
    expect(mockConfirm).toHaveBeenCalledWith({
      orgId: 'org-1',
      requestedByUserId: 'user-1',
      code: '123456',
      salt: 'deadbeef',
    });
  });

  // Idempotent by design: the record's attribute_not_exists makes the second
  // confirm a no-op, and the caller should not see that as a failure.
  it('202s a double confirm', async () => {
    mockConfirm.mockResolvedValue({ outcome: 'already_deleting' });

    expect((await baseHandler(event(VALID))).statusCode).toBe(202);
  });

  it('403s a non-admin before spending anything', async () => {
    mockIsOrgAdmin.mockResolvedValue(false);

    const result = await baseHandler(event(VALID));

    expect(result.statusCode).toBe(403);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('400s when the typed org name does not match', async () => {
    const result = await baseHandler(event({ ...VALID, orgName: 'Wrong Corp' }));

    expect(result.statusCode).toBe(400);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed code', { code: 'abc', orgName: 'Acme Corp' }],
    ['a missing org name', { code: '123456' }],
    ['invalid JSON', 'not-json{'],
  ])('400s for %s', async (_label, body) => {
    const result = await baseHandler(event(body));

    expect(result.statusCode).toBe(400);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('410s expired_or_locked when no challenge row remains', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    const result = await baseHandler(event(VALID));

    expect(result.statusCode).toBe(410);
    expect(JSON.parse(result.body!).code).toBe(ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  // The cancelled transaction increments nothing, so without this the attempt
  // limiter never engages.
  it('410s a wrong code and consumes an attempt', async () => {
    mockConfirm.mockResolvedValue({ outcome: 'code_invalid' });

    const result = await baseHandler(event(VALID));

    expect(result.statusCode).toBe(410);
    expect(JSON.parse(result.body!).code).toBe(ApiErrorCode.DELETION_CODE_INVALID);
    expect(mockConsumeAttempt).toHaveBeenCalledWith('org-1');
  });

  it('does not spend an attempt on a code that is already expired or locked', async () => {
    mockConfirm.mockResolvedValue({ outcome: 'code_expired_or_locked' });

    const result = await baseHandler(event(VALID));

    expect(result.statusCode).toBe(410);
    expect(mockConsumeAttempt).not.toHaveBeenCalled();
  });

  it('reads the org profile and the salt consistently', async () => {
    await baseHandler(event(VALID));

    expect(mockGetOrgProfile).toHaveBeenCalled();
    expect(ddbMock.commandCalls(GetItemCommand)[0]!.args[0].input).toMatchObject({
      TableName: 'DeletionChallengeTable',
      ConsistentRead: true,
    });
  });
});
