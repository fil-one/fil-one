import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import { enforceIdentityProvider, resolveActiveOrg } from './org-context.js';

const PERSONAL_ORG = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';

function eventWithHeader(headers: Record<string, string>): AuthenticatedEvent {
  const event = buildEvent({ userInfo: { orgId: PERSONAL_ORG, userId: USER_ID } });
  Object.assign(event.headers, headers);
  return event;
}

/** No `auth0OrgId` — every org in M1. */
function stubUnrestrictedProfile(orgId: string): void {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({ Item: { name: { S: 'Acme' } } });
}

describe('resolveActiveOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    stubUnrestrictedProfile(PERSONAL_ORG);
    stubUnrestrictedProfile(OTHER_ORG);
  });

  it('leaves the identity row’s org in place when no header is sent', () => {
    const event = eventWithHeader({});

    const result = resolveActiveOrg(event);

    expect(result).toEqual({});
    expect(event.requestContext.userInfo.orgId).toBe(PERSONAL_ORG);
  });

  it('costs no reads at all', () => {
    resolveActiveOrg(eventWithHeader({ 'x-org-id': OTHER_ORG }));

    // Which org a request is about is decided from the header and the identity
    // row alone, so the membership read that follows is the first thing this
    // request spends — and it is spent on the org it is actually about.
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it('makes the named org the active one', () => {
    const event = eventWithHeader({ 'x-org-id': OTHER_ORG });

    const result = resolveActiveOrg(event);

    expect(result.response).toBeUndefined();
    expect(event.requestContext.userInfo.orgId).toBe(OTHER_ORG);
  });

  it('reads the header whatever case it arrived in', () => {
    const event = eventWithHeader({ 'X-Org-Id': OTHER_ORG });

    resolveActiveOrg(event);

    expect(event.requestContext.userInfo.orgId).toBe(OTHER_ORG);
  });

  it('lower-cases the value it was given', () => {
    const event = eventWithHeader({ 'x-org-id': OTHER_ORG.toUpperCase() });

    const result = resolveActiveOrg(event);

    // Upper case is a valid UUID spelling and every key here is compared byte
    // for byte, so left as sent this would validate and then match no
    // membership row — a "you are not a member" for a spelling.
    expect(result.response).toBeUndefined();
    expect(event.requestContext.userInfo.orgId).toBe(OTHER_ORG);
  });

  it('reports the identity row’s org so /me can fall back to it', () => {
    const event = eventWithHeader({ 'x-org-id': OTHER_ORG });

    const result = resolveActiveOrg(event);

    expect(result.personalOrgId).toBe(PERSONAL_ORG);
  });

  it('names no fallback when the header names the caller’s own org', () => {
    const event = eventWithHeader({ 'x-org-id': PERSONAL_ORG });

    const result = resolveActiveOrg(event);

    expect(result).toEqual({});
    expect(event.requestContext.userInfo.orgId).toBe(PERSONAL_ORG);
  });

  it('drops the membership the signup branch attached for the org it created', () => {
    const event = buildEvent({
      userInfo: {
        orgId: PERSONAL_ORG,
        userId: USER_ID,
        membership: membershipFor(PERSONAL_ORG, USER_ID, OrgRole.Owner),
      },
    });
    event.headers['x-org-id'] = OTHER_ORG;

    resolveActiveOrg(event);

    // Carrying it would authorize the request in the named org with the role the
    // caller holds in a different one.
    expect(event.requestContext.userInfo.membership).toBeUndefined();
  });

  describe('a malformed header', () => {
    it.each([
      ['not a uuid', 'org-B'],
      ['carrying the key separator', `ORG#${OTHER_ORG}`],
      ['empty', ''],
    ])('is a 400 when %s', (_label, value) => {
      const event = eventWithHeader({ 'x-org-id': value });

      const result = resolveActiveOrg(event);

      expect(result.response?.statusCode).toBe(400);
      expect(event.requestContext.userInfo.orgId).toBe(PERSONAL_ORG);
      // Refused before it could reach a key expression or cost a read.
      expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
    });
  });
});

describe('enforceIdentityProvider', () => {
  function stubRestrictedProfile(orgId: string, auth0OrgId: string): void {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({ Item: { name: { S: 'Acme' }, auth0OrgId: { S: auth0OrgId } } });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    stubUnrestrictedProfile(PERSONAL_ORG);
    stubUnrestrictedProfile(OTHER_ORG);
  });

  it('admits an org that authenticates nowhere in particular', async () => {
    expect(await enforceIdentityProvider(OTHER_ORG, null)).toBeUndefined();
  });

  it('answers 410 for a deleting active org', async () => {
    // The active-org half of the session fence: naming a deleting org in the
    // header must not keep a member operating inside its teardown. A response
    // rather than a throw, so /api/me's fallback can degrade a stashed
    // deleting org to the caller's own.
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${OTHER_ORG}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({ Item: { name: { S: 'Acme' }, deleting: { BOOL: true } } });

    const refusal = await enforceIdentityProvider(OTHER_ORG, null);

    expect(refusal?.statusCode).toBe(410);
  });

  it('refuses an org whose auth0OrgId the session did not authenticate at', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubRestrictedProfile(OTHER_ORG, 'org_auth0_acme');

    const refusal = await enforceIdentityProvider(OTHER_ORG, null);

    expect(refusal?.statusCode).toBe(403);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses a session authenticated at a different Auth0 organization', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubRestrictedProfile(OTHER_ORG, 'org_auth0_acme');

    const refusal = await enforceIdentityProvider(OTHER_ORG, 'org_auth0_somebody_else');

    expect(refusal?.statusCode).toBe(403);
    warn.mockRestore();
  });

  it('admits the session whose org_id claim matches', async () => {
    stubRestrictedProfile(OTHER_ORG, 'org_auth0_acme');

    expect(await enforceIdentityProvider(OTHER_ORG, 'org_auth0_acme')).toBeUndefined();
  });

  it('applies to the caller’s own org too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // An SSO org can be somebody's own, and the rule is about which sessions may
    // enter it. The middleware runs this on whichever org the request resolved
    // to, so a session cannot reach its own SSO org by sending no header.
    stubRestrictedProfile(PERSONAL_ORG, 'org_auth0_acme');

    expect((await enforceIdentityProvider(PERSONAL_ORG, null))?.statusCode).toBe(403);
    warn.mockRestore();
  });

  it('answers a retryable 503 when the profile row will not read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(GetItemCommand, { TableName: 'UserInfoTable' }).rejects(new Error('unavailable'));

    const refusal = await enforceIdentityProvider(OTHER_ORG, null);

    // Failing open here would bypass the one check that keeps a session out of
    // an org it was not authenticated for.
    expect(refusal?.statusCode).toBe(503);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('admits an org whose profile row is missing entirely', async () => {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${OTHER_ORG}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({});

    // Absence is read tolerantly: nothing writes auth0OrgId in M1, and the
    // membership read is what decides whether the caller may be here.
    expect(await enforceIdentityProvider(OTHER_ORG, null)).toBeUndefined();
  });

  it('reads the profile consistently', async () => {
    await enforceIdentityProvider(OTHER_ORG, null);

    // `auth0OrgId` is written when an org adopts SSO and cleared when it leaves.
    // A stale replica answering "no restriction" would admit exactly the session
    // this rule exists to refuse.
    expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input).toMatchObject({
      ConsistentRead: true,
    });
  });
});
