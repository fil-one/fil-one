import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import {
  accessKeyMintSeqItem,
  accessKeyMintSeqUnchangedCheck,
  readAccessKeyMintSeq,
} from './access-key-mint-seq.ts';

const MEMBER = { orgId: 'org-1', userId: 'user-1' };
const KEY = { pk: { S: 'ORG#org-1' }, sk: { S: 'ACCESSKEY_MINT_SEQ#user-1' } };

describe('the access-key mint sequence', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  describe('readAccessKeyMintSeq', () => {
    it('reads the sequence consistently, since the listing that follows depends on it', async () => {
      ddbMock.on(GetItemCommand).resolves({ Item: marshall({ ...KEY, mintSeq: 4 }) });

      expect(await readAccessKeyMintSeq(MEMBER)).toBe(4);
      expect(ddbMock.commandCalls(GetItemCommand)[0]!.args[0].input).toMatchObject({
        Key: KEY,
        ConsistentRead: true,
      });
    });

    // The absence of the row, not a zero: nothing seeds it, and the check below
    // asserts that absence rather than a value nobody wrote.
    it('reads a member who has never minted a key as no sequence at all', async () => {
      ddbMock.on(GetItemCommand).resolves({});

      expect(await readAccessKeyMintSeq(MEMBER)).toBeUndefined();
    });
  });

  describe('accessKeyMintSeqItem', () => {
    it('advances the sequence, creating the row on the first mint', () => {
      expect(accessKeyMintSeqItem(MEMBER).Update).toMatchObject({
        Key: KEY,
        UpdateExpression: 'ADD mintSeq :one',
        ExpressionAttributeValues: { ':one': { N: '1' } },
      });
    });
  });

  describe('accessKeyMintSeqUnchangedCheck', () => {
    it('asserts the sequence it was given', () => {
      expect(
        accessKeyMintSeqUnchangedCheck(MEMBER.orgId, { userId: MEMBER.userId, mintSeq: 4 })
          .ConditionCheck,
      ).toMatchObject({
        Key: KEY,
        ConditionExpression: 'attribute_exists(pk) AND mintSeq = :seen',
        ExpressionAttributeValues: { ':seen': { N: '4' } },
      });
    });

    it('asserts the row is still absent when nothing had been minted', () => {
      const check = accessKeyMintSeqUnchangedCheck(MEMBER.orgId, {
        userId: MEMBER.userId,
        mintSeq: undefined,
      }).ConditionCheck;

      expect(check).toMatchObject({ Key: KEY, ConditionExpression: 'attribute_not_exists(pk)' });
      // Nothing to compare against, so no value rides along.
      expect(check?.ExpressionAttributeValues).toBeUndefined();
    });
  });
});
