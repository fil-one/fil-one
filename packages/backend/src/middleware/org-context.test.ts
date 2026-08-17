import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import { resolveActiveOrg } from './org-context.js';

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

  it('leaves the identity row’s org in place when no header is sent', async () => {
    const event = eventWithHeader({});

    const result = await resolveActiveOrg(event, null);

    expect(result).toEqual({});
    expect(event.requestContext.userInfo.orgId).toBe(PERSONAL_ORG);
    // A curl caller costs no reads at all: the org is already resolved.
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it('makes the named org the active one', async () => {
    const event = eventWithHeader({ 'x-org-id': OTHER_ORG });

    const result = await resolveActiveOrg(event, null);

    expect(result.response).toBeUndefined();
    expect(event.requestContext.userInfo.orgId).toBe(OTHER_ORG);
  });

  it('reads the header whatever case it arrived in', async () => {
    const event = eventWithHeader({ 'X-Org-Id': OTHER_ORG });

    await resolveActiveOrg(event, null);

    expect(event.requestContext.userInfo.orgId).toBe(OTHER_ORG);
  });

  it('reports the identity row’s org so /me can fall back to it', async () => {
    const event = eventWithHeader({ 'x-org-id': OTHER_ORG });

    const result = await resolveActiveOrg(event, null);

    expect(result.personalOrgId).toBe(PERSONAL_ORG);
  });

  it('names no fallback when the header names the caller’s own org', async () => {
    const event = eventWithHeader({ 'x-org-id': PERSONAL_ORG });

    const result = await resolveActiveOrg(event, null);

    expect(result).toEqual({});
    expect(event.requestContext.userInfo.orgId).toBe(PERSONAL_ORG);
  });

  it('drops the membership the signup branch attached for the org it created', async () => {
    const event = buildEvent({
      userInfo: {
        orgId: PERSONAL_ORG,
        userId: USER_ID,
        membership: membershipFor(PERSONAL_ORG, USER_ID, OrgRole.Owner),
      },
    });
    event.headers['x-org-id'] = OTHER_ORG;

    await resolveActiveOrg(event, null);

    // Carrying it would authorize the request in the named org with the role the
    // caller holds in a different one.
    expect(event.requestContext.userInfo.membership).toBeUndefined();
  });

  describe('a malformed header', () => {
    it.each([
      ['not a uuid', 'org-B'],
      ['carrying the key separator', `ORG#${OTHER_ORG}`],
      ['empty', ''],
    ])('is a 400 when %s', async (_label, value) => {
      const event = eventWithHeader({ 'x-org-id': value });

      const result = await resolveActiveOrg(event, null);

      expect(result.response?.statusCode).toBe(400);
      expect(event.requestContext.userInfo.orgId).toBe(PERSONAL_ORG);
      // Refused before it could reach a key expression or cost a read.
      expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
    });
  });

  describe('the identity-provider rule', () => {
    function stubRestrictedProfile(orgId: string, auth0OrgId: string): void {
      ddbMock
        .on(GetItemCommand, {
          TableName: 'UserInfoTable',
          Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
        })
        .resolves({ Item: { name: { S: 'Acme' }, auth0OrgId: { S: auth0OrgId } } });
    }

    it('refuses an org whose auth0OrgId the session did not authenticate at', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubRestrictedProfile(OTHER_ORG, 'org_auth0_acme');
      const event = eventWithHeader({ 'x-org-id': OTHER_ORG });

      const result = await resolveActiveOrg(event, null);

      expect(result.response?.statusCode).toBe(403);
      expect(event.requestContext.userInfo.orgId).toBe(PERSONAL_ORG);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('refuses a session authenticated at a different Auth0 organization', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubRestrictedProfile(OTHER_ORG, 'org_auth0_acme');
      const event = eventWithHeader({ 'x-org-id': OTHER_ORG });

      const result = await resolveActiveOrg(event, 'org_auth0_somebody_else');

      expect(result.response?.statusCode).toBe(403);
      warn.mockRestore();
    });

    it('admits the session whose org_id claim matches', async () => {
      stubRestrictedProfile(OTHER_ORG, 'org_auth0_acme');
      const event = eventWithHeader({ 'x-org-id': OTHER_ORG });

      const result = await resolveActiveOrg(event, 'org_auth0_acme');

      expect(result.response).toBeUndefined();
      expect(event.requestContext.userInfo.orgId).toBe(OTHER_ORG);
    });

    it('applies to the caller’s own org too', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // The header names the org the identity row already points at. An SSO org
      // can be somebody's own, and the rule is about which sessions may enter
      // it — not about whether the header moved the active org.
      stubRestrictedProfile(PERSONAL_ORG, 'org_auth0_acme');
      const event = eventWithHeader({ 'x-org-id': PERSONAL_ORG });

      const result = await resolveActiveOrg(event, null);

      expect(result.response?.statusCode).toBe(403);
      warn.mockRestore();
    });

    it('answers a retryable 503 when the profile row will not read', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      ddbMock.on(GetItemCommand, { TableName: 'UserInfoTable' }).rejects(new Error('unavailable'));
      const event = eventWithHeader({ 'x-org-id': OTHER_ORG });

      const result = await resolveActiveOrg(event, null);

      // Failing open here would bypass the one check that keeps a session out of
      // an org it was not authenticated for.
      expect(result.response?.statusCode).toBe(503);
      expect(event.requestContext.userInfo.orgId).toBe(PERSONAL_ORG);
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
      const event = eventWithHeader({ 'x-org-id': OTHER_ORG });

      // Absence is read tolerantly: nothing writes auth0OrgId in M1, and the
      // membership read is what decides whether the caller may be here.
      const result = await resolveActiveOrg(event, null);

      expect(result.response).toBeUndefined();
      expect(event.requestContext.userInfo.orgId).toBe(OTHER_ORG);
    });
  });
});
