import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());
// Avoid unrelated profile/logo S3 dependencies. The real key builders are
// irrelevant to transaction membership; the real commitAudited path runs.
vi.mock('./org-membership.ts', () => ({
  OrgKeys: new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...ids: string[]) =>
          `${String(name)}#${ids.join('#')}`,
    },
  ),
}));
import { createNewUserAndOrg } from './account-creation.ts';

const ddb = mockClient(DynamoDBClient);
const signup = {
  sub: 'auth0|any-user',
  userId: 'any-user',
  orgId: 'any-org',
  orgName: 'Any organization',
  email: 'private@example.org',
};

beforeEach(() => {
  ddb.reset();
  vi.stubEnv('FILONE_LIFECYCLE_OUTBOX_TABLE', 'any-outbox');
  vi.stubEnv('FILONE_LIFECYCLE_FIRST_MILESTONE_EPOCH', 'any-epoch');
});
afterEach(() => vi.unstubAllEnvs());

describe('committed signup lifecycle outcomes', () => {
  it('commits the signup and its outbox record in the same transaction', async () => {
    ddb.on(TransactWriteItemsCommand).resolves({});
    await createNewUserAndOrg(signup);
    const transaction = ddb.commandCalls(TransactWriteItemsCommand)[0].args[0].input;
    const outbox = transaction.TransactItems!.find((item) => item.Put?.TableName === 'any-outbox');
    expect(unmarshall(outbox!.Put!.Item!).detail).toMatchObject({
      event_type: 'organization.signup',
      organization_id: signup.orgId,
      email_domain: 'example.org',
    });
    const organizationProfile = transaction.TransactItems!.find(
      (item) =>
        item.Put?.TableName === 'UserInfoTable' && item.Put.Item?.pk.S === `ORG#${signup.orgId}`,
    );
    expect(organizationProfile!.Put!.Item!.lifecycleCaptureStartedAt.S).toBe(
      unmarshall(outbox!.Put!.Item!).detail.occurred_at,
    );
    expect(organizationProfile!.Put!.Item!.lifecycleCaptureEpoch).toStrictEqual({ S: 'any-epoch' });
    expect(transaction.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Put: expect.objectContaining({ TableName: 'UserInfoTable' }) }),
        expect.objectContaining({ Put: expect.objectContaining({ TableName: 'OrgTable' }) }),
        expect.objectContaining({ Put: expect.objectContaining({ TableName: 'AuditTable' }) }),
      ]),
    );
  });

  it('does not enroll an Organization in first-event capture when signup capture is off', async () => {
    vi.stubEnv('FILONE_LIFECYCLE_OUTBOX_TABLE', '');
    ddb.on(TransactWriteItemsCommand).resolves({});
    await createNewUserAndOrg(signup);
    const transaction = ddb.commandCalls(TransactWriteItemsCommand)[0].args[0].input;
    const organizationProfile = transaction.TransactItems!.find(
      (item) =>
        item.Put?.TableName === 'UserInfoTable' && item.Put.Item?.pk.S === `ORG#${signup.orgId}`,
    );
    expect(organizationProfile!.Put!.Item).not.toHaveProperty('lifecycleCaptureStartedAt');
    expect(organizationProfile!.Put!.Item).not.toHaveProperty('lifecycleCaptureEpoch');
    expect(
      transaction.TransactItems!.filter((item) => item.Put?.TableName === 'any-outbox'),
    ).toStrictEqual([]);
  });

  it('retains the exact outbox write when an audit-only failure retries the signup', async () => {
    ddb
      .on(TransactWriteItemsCommand)
      .callsFakeOnce((input) => {
        throw new TransactionCanceledException({
          $metadata: {},
          message: 'audit-only capacity failure',
          CancellationReasons: input.TransactItems.map((item: { Put?: { TableName: string } }) => ({
            Code: item.Put?.TableName === 'AuditTable' ? 'ProvisionedThroughputExceeded' : 'None',
          })),
        });
      })
      .resolves({});
    await createNewUserAndOrg(signup);
    const writes = ddb
      .commandCalls(TransactWriteItemsCommand)
      .map((call) => call.args[0].input.TransactItems!);
    expect(writes).toHaveLength(2);
    const outbox = writes[0].find((item) => item.Put?.TableName === 'any-outbox');
    expect(writes[1]).toEqual(expect.arrayContaining([outbox]));
    expect(writes[1].filter((item) => item.Put?.TableName === 'AuditTable')).toStrictEqual([]);
  });

  it('fails signup when the outbox transaction fails instead of dropping the outcome', async () => {
    const failure = new TransactionCanceledException({
      $metadata: {},
      message: 'outbox failure',
      CancellationReasons: [
        ...Array.from({ length: 6 }, () => ({ Code: 'None' })),
        { Code: 'ProvisionedThroughputExceeded' },
        { Code: 'None' },
      ],
    });
    ddb.on(TransactWriteItemsCommand).rejects(failure);
    await expect(createNewUserAndOrg(signup)).rejects.toThrow('outbox failure');
    expect(ddb.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });
});
