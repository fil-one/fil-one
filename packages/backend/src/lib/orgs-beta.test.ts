import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import { hasOrgsBetaAccess } from './orgs-beta.js';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const EMAIL = 'Inviter@Example.com';

function grant(pk: string) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: pk }, sk: { S: 'ORGS_BETA' } },
    })
    .resolves({ Item: { pk: { S: pk }, sk: { S: 'ORGS_BETA' } } });
}

describe('hasOrgsBetaAccess', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(GetItemCommand).resolves({});
  });

  it('grants on the caller’s own allowlist row, keyed by the lowercased email', () => {
    grant('ALLOWLIST#inviter@example.com');

    return expect(hasOrgsBetaAccess({ verifiedEmail: EMAIL, orgId: ORG_ID })).resolves.toBe(true);
  });

  it('grants on the org’s row, which is what an enterprise beta enables', async () => {
    // FilOne learns an employee's email only at their first login, so enabling a
    // whole org has to be possible without enumerating its members.
    grant(`ORG#${ORG_ID}`);

    expect(await hasOrgsBetaAccess({ verifiedEmail: EMAIL, orgId: ORG_ID })).toBe(true);
  });

  it('denies when neither row exists', async () => {
    expect(await hasOrgsBetaAccess({ verifiedEmail: EMAIL, orgId: ORG_ID })).toBe(false);
  });

  it('ignores an unverified or absent email but still honours the org row', async () => {
    grant('ALLOWLIST#inviter@example.com');

    // The address a session claims without verifying it grants nothing, the same
    // reading the RAG gate takes.
    expect(await hasOrgsBetaAccess({ orgId: ORG_ID })).toBe(false);

    grant(`ORG#${ORG_ID}`);
    expect(await hasOrgsBetaAccess({ orgId: ORG_ID })).toBe(true);
  });

  it('reads both rows consistently and in parallel', async () => {
    await hasOrgsBetaAccess({ verifiedEmail: EMAIL, orgId: ORG_ID });

    const calls = ddbMock.commandCalls(GetItemCommand);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // Granting the flag is a manual operation somebody performs and then
      // immediately tries.
      expect(call.args[0].input.ConsistentRead).toBe(true);
    }
  });

  it('makes no read at all for a caller with no verified email and no org grant', async () => {
    await hasOrgsBetaAccess({ orgId: ORG_ID });

    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(1);
  });
});
