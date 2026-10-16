import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockCreateBillingTrial = vi.fn();
vi.mock('./create-billing-trial.ts', () => ({
  createBillingTrial: (args: unknown) => mockCreateBillingTrial(args),
}));

const ddbMock = mockClient(DynamoDBClient);

import { ensureTrialEntitlement } from './trial-entitlement.ts';
import { TrialEntitlementError } from './errors.ts';

const EMAIL_PUT = { Item: { pk: { S: 'EMAIL_NORM#user@gmail.com' } } };
const ACCOUNT_PUT = { Item: { pk: { S: 'USER#user-1' } } };

function claimedAlready(Item: Record<string, { S: string }>) {
  return new ConditionalCheckFailedException({ message: 'exists', $metadata: {}, Item });
}

const BASE = {
  sub: 'auth0|sub-1',
  userId: 'user-1',
  orgId: 'org-1',
  email: 'User+tag@gmail.com', // normalizes to user@gmail.com
  emailVerified: true,
};

describe('ensureTrialEntitlement', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    mockCreateBillingTrial.mockResolvedValue(undefined);
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
  });

  it('returns false and writes nothing when email is unverified', async () => {
    const result = await ensureTrialEntitlement({ ...BASE, emailVerified: false });

    expect(result).toBe(false);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(mockCreateBillingTrial).not.toHaveBeenCalled();
  });

  it('returns false and writes nothing when email is null', async () => {
    const result = await ensureTrialEntitlement({ ...BASE, email: null });

    expect(result).toBe(false);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('claims the normalized key, creates the trial, and sets the flag when claim is won', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await ensureTrialEntitlement(BASE);

    expect(result).toBe(true);

    expect(ddbMock.commandCalls(PutItemCommand).map((c) => c.args[0].input)).toStrictEqual([
      {
        TableName: 'UserInfoTable',
        Item: {
          pk: { S: 'EMAIL_NORM#user@gmail.com' },
          sk: { S: 'TRIAL_ENTITLEMENT' },
          userId: { S: 'user-1' },
          orgId: { S: 'org-1' },
          createdAt: { S: expect.any(String) },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
      {
        TableName: 'UserInfoTable',
        Item: {
          pk: { S: 'USER#user-1' },
          sk: { S: 'TRIAL_ENTITLEMENT' },
          orgId: { S: 'org-1' },
          createdAt: { S: expect.any(String) },
        },
        ConditionExpression: 'attribute_not_exists(pk) OR orgId = :orgId',
        ExpressionAttributeValues: { ':orgId': { S: 'org-1' } },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    ]);

    expect(mockCreateBillingTrial).toHaveBeenCalledWith({
      userId: 'user-1',
      orgId: 'org-1',
      email: 'User+tag@gmail.com',
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.UpdateExpression).toBe('SET emailEntitlementClaimed = :t');
  });

  it('does not create a trial when the key is already claimed by another account', async () => {
    ddbMock.on(PutItemCommand, EMAIL_PUT).rejects(
      new ConditionalCheckFailedException({
        message: 'exists',
        $metadata: {},
        Item: { userId: { S: 'someone-else' } },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await ensureTrialEntitlement(BASE);

    expect(result).toBe(false);
    expect(mockCreateBillingTrial).not.toHaveBeenCalled();
    // Flag is still set so we stop re-checking this identity.
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
  });

  it('logs the permanent denial at warn so it is visible in production logs', async () => {
    // Production Lambdas run with applicationLogLevel WARN; console.info would
    // make this denial invisible.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ddbMock.on(PutItemCommand, EMAIL_PUT).rejects(
      new ConditionalCheckFailedException({
        message: 'exists',
        $metadata: {},
        Item: { userId: { S: 'someone-else' } },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    await ensureTrialEntitlement(BASE);

    expect(warnSpy).toHaveBeenCalledWith(
      '[trial-entitlement] Normalized email already claimed — no trial granted',
      { userId: 'user-1', orgId: 'org-1' },
    );
    warnSpy.mockRestore();
  });

  it('creates the trial when the same user retries for the org the claim was spent on', async () => {
    ddbMock.on(PutItemCommand, EMAIL_PUT).rejects(
      new ConditionalCheckFailedException({
        message: 'exists',
        $metadata: {},
        Item: { userId: { S: 'user-1' }, orgId: { S: 'org-1' } },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await ensureTrialEntitlement(BASE);

    expect(result).toBe(true);
    expect(mockCreateBillingTrial).toHaveBeenCalledOnce();
  });

  // One trial per person: a second org of theirs (one they created, or the
  // floor org made when they leave their last one) gets no trial of its own.
  it('refuses the same user asking from a different org', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ddbMock.on(PutItemCommand, EMAIL_PUT).rejects(
      new ConditionalCheckFailedException({
        message: 'exists',
        $metadata: {},
        Item: { userId: { S: 'user-1' }, orgId: { S: 'org-first' } },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await ensureTrialEntitlement(BASE);

    expect(result).toBe(false);
    expect(mockCreateBillingTrial).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[trial-entitlement] Trial already spent on another org; no trial granted',
      { userId: 'user-1', orgId: 'org-1', claimedOrgId: 'org-first' },
    );
    warnSpy.mockRestore();
  });

  // Written before the claim recorded its org. The owner's first request
  // stamps its org, so an interrupted claim can still be retried.
  describe('a claim with no recorded org', () => {
    const STAMP = { UpdateExpression: 'SET orgId = :orgId' };

    beforeEach(() => {
      ddbMock.on(PutItemCommand, EMAIL_PUT).rejects(
        new ConditionalCheckFailedException({
          message: 'exists',
          $metadata: {},
          Item: { userId: { S: 'user-1' } },
        }),
      );
      ddbMock.on(UpdateItemCommand).resolves({});
    });

    it('stamps the org it is asked from and creates the trial', async () => {
      const result = await ensureTrialEntitlement(BASE);

      expect(result).toBe(true);
      expect(mockCreateBillingTrial).toHaveBeenCalledOnce();
      expect(ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input).toMatchObject({
        Key: { pk: { S: 'EMAIL_NORM#user@gmail.com' }, sk: { S: 'TRIAL_ENTITLEMENT' } },
        UpdateExpression: 'SET orgId = :orgId',
        ConditionExpression: 'attribute_not_exists(orgId) AND userId = :userId',
        ExpressionAttributeValues: { ':orgId': { S: 'org-1' }, ':userId': { S: 'user-1' } },
      });
    });

    it.each([
      ['refuses', 'org-other', false],
      ['still grants', 'org-1', true],
    ])(
      '%s the trial when a racing request stamped %s first',
      async (_label, stampedOrgId, entitled) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        ddbMock.on(UpdateItemCommand, STAMP).rejects(
          new ConditionalCheckFailedException({
            message: 'stamped',
            $metadata: {},
            Item: { userId: { S: 'user-1' }, orgId: { S: stampedOrgId } },
          }),
        );

        expect(await ensureTrialEntitlement(BASE)).toBe(entitled);
        expect(mockCreateBillingTrial).toHaveBeenCalledTimes(entitled ? 1 : 0);
      },
    );

    // The prefill may not have run: a claim spent on the signup org must not be
    // stamped from an org the account created, or from its floor org.
    it.each(['manual', 'invitation'] as const)(
      'neither stamps nor grants from a %s membership',
      async (membershipSource) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(await ensureTrialEntitlement({ ...BASE, membershipSource })).toBe(false);
        expect(mockCreateBillingTrial).not.toHaveBeenCalled();
        expect(
          ddbMock.commandCalls(UpdateItemCommand).map((c) => c.args[0].input.UpdateExpression),
        ).toEqual(['SET emailEntitlementClaimed = :t']);
      },
    );

    it('stamps from the signup org', async () => {
      expect(await ensureTrialEntitlement({ ...BASE, membershipSource: 'signup' })).toBe(true);
    });
  });

  // update-profile lets a database account change its address, and the new
  // address has no claim. The account's own claim still names the first org.
  it('refuses an account that spent its trial on another org under a previous email', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ddbMock.on(PutItemCommand, ACCOUNT_PUT).rejects(claimedAlready({ orgId: { S: 'org-first' } }));

    expect(await ensureTrialEntitlement({ ...BASE, email: 'new-address@example.com' })).toBe(false);
    expect(mockCreateBillingTrial).not.toHaveBeenCalled();
  });

  it('grants one trial when the same person claims for two orgs at once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = new Map<string, Record<string, { S: string }>>();
    ddbMock.on(PutItemCommand).callsFake(({ Item, ExpressionAttributeValues }) => {
      const existing = rows.get(Item.pk.S);
      if (existing && existing.orgId?.S !== ExpressionAttributeValues?.[':orgId']?.S) {
        throw claimedAlready(existing);
      }
      rows.set(Item.pk.S, existing ?? Item);
      return {};
    });

    const results = await Promise.all([
      ensureTrialEntitlement({ ...BASE, orgId: 'org-a' }),
      ensureTrialEntitlement({ ...BASE, orgId: 'org-b' }),
    ]);

    expect(results).toEqual([true, false]);
    expect(mockCreateBillingTrial.mock.calls).toEqual([
      [{ userId: 'user-1', orgId: 'org-a', email: BASE.email }],
    ]);
  });

  it('throws and does not set the flag on a transient claim error', async () => {
    ddbMock.on(PutItemCommand, EMAIL_PUT).rejects(new Error('Service unavailable'));

    await expect(ensureTrialEntitlement(BASE)).rejects.toThrow(TrialEntitlementError);
    expect(mockCreateBillingTrial).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('throws and does not set the flag when trial creation fails', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateBillingTrial.mockRejectedValue(new Error('Stripe down'));

    await expect(ensureTrialEntitlement(BASE)).rejects.toThrow(TrialEntitlementError);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });
});
