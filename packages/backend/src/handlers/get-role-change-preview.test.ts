import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { ApiErrorCode, OrgRole, S3Region } from '@filone/shared';
import type { ErrorResponse, RoleChangePreviewResponse } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './get-role-change-preview.js';
import {
  buildEvent,
  membershipFor,
  stubAbsentMembershipRead,
  stubMembershipRead,
} from '../test/lambda-test-utilities.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const CALLER = 'caller-user-id';
const TARGET = 'target-user-id';

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(QueryCommand).resolves({ Items: [] });
});

function previewEvent({
  role = OrgRole.Member,
  callerRole = OrgRole.Owner,
  targetUserId = TARGET as string | null,
}: { role?: string; callerRole?: OrgRole; targetUserId?: string | null } = {}) {
  const event = buildEvent({
    userInfo: {
      userId: CALLER,
      orgId: ORG_ID,
      membership: membershipFor(ORG_ID, CALLER, callerRole),
    },
    method: 'GET',
  });
  return Object.assign(event, {
    ...(targetUserId ? { pathParameters: { userId: targetUserId } } : {}),
    queryStringParameters: role ? { role } : {},
  }) as unknown as AuthenticatedEvent;
}

function keyRow(overrides: Record<string, unknown> = {}) {
  return marshall(
    {
      pk: `ORG#${ORG_ID}`,
      sk: 'ACCESSKEY#key-1',
      keyName: 'nightly backup',
      accessKeyId: 'AKIAEXAMPLE9999',
      createdAt: '2026-02-01T00:00:00.000Z',
      status: 'active',
      region: S3Region.UsEast1,
      createdBy: TARGET,
      permissions: ['read', 'DeleteBucket'],
      ...overrides,
    },
    { removeUndefinedValues: true },
  );
}

function bodyOf<T>(result: { body?: string }): T {
  return JSON.parse(result.body ?? '{}') as T;
}

describe('get-role-change-preview baseHandler', () => {
  it('lists the keys the target could no longer mint', async () => {
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET, role: OrgRole.Admin });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        keyRow(),
        keyRow({ sk: 'ACCESSKEY#key-2', keyName: 'reader', permissions: ['read'] }),
        keyRow({ sk: 'ACCESSKEY#key-3', createdBy: undefined }),
      ],
    });

    const result = await baseHandler(previewEvent({ role: OrgRole.Member }));

    expect(result.statusCode).toBe(200);
    expect(bodyOf<RoleChangePreviewResponse>(result)).toStrictEqual({
      currentRole: OrgRole.Admin,
      role: OrgRole.Member,
      keys: [
        {
          id: 'key-1',
          keyName: 'nightly backup',
          accessKeyIdSuffix: '9999',
          region: S3Region.UsEast1,
          createdAt: '2026-02-01T00:00:00.000Z',
          reason: 'exceeds_role',
          excess: ['DeleteBucket'],
        },
      ],
      survivingCount: 1,
      unattributedCount: 1,
    });
  });

  it('carries four characters of the access key id and no more', async () => {
    // The console already shows this much. A whole AKIA in a response body is a
    // credential half nobody needs to recognize a key by.
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET, role: OrgRole.Admin });
    ddbMock.on(QueryCommand).resolves({ Items: [keyRow()] });

    const result = await baseHandler(previewEvent({ role: OrgRole.Member }));

    expect(result.body).not.toContain('AKIAEXAMPLE9999');
    expect(result.body).toContain('9999');
  });

  it('condemns every key on a demotion to ReadOnly, which can hold none', async () => {
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET, role: OrgRole.Admin });
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [keyRow({ permissions: ['read'] }), keyRow({ sk: 'ACCESSKEY#key-2' })] });

    const body = bodyOf<RoleChangePreviewResponse>(
      await baseHandler(previewEvent({ role: OrgRole.ReadOnly })),
    );

    expect(body.keys.map((key) => [key.id, key.reason])).toStrictEqual([
      ['key-1', 'role_cannot_mint'],
      ['key-2', 'role_cannot_mint'],
    ]);
    expect(body.survivingCount).toBe(0);
  });

  it('condemns nothing on a promotion', async () => {
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET, role: OrgRole.Member });
    ddbMock.on(QueryCommand).resolves({ Items: [keyRow({ permissions: ['read'] })] });

    const body = bodyOf<RoleChangePreviewResponse>(
      await baseHandler(previewEvent({ role: OrgRole.Admin })),
    );

    expect(body).toMatchObject({ keys: [], survivingCount: 1 });
  });

  it('answers the same shape when the org holds no keys at all', async () => {
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET, role: OrgRole.Admin });

    expect(bodyOf<RoleChangePreviewResponse>(await baseHandler(previewEvent()))).toStrictEqual({
      currentRole: OrgRole.Admin,
      role: OrgRole.Member,
      keys: [],
      survivingCount: 0,
      unattributedCount: 0,
    });
  });

  it('promises nothing for the role the member already holds', async () => {
    // The PATCH short-circuits on an unchanged role, so the preview of one has
    // to agree: a key already above its holder's current role is not about to
    // be revoked by a change that does nothing.
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET, role: OrgRole.Member });
    ddbMock.on(QueryCommand).resolves({ Items: [keyRow(), keyRow({ sk: 'ACCESSKEY#key-2' })] });

    const body = bodyOf<RoleChangePreviewResponse>(
      await baseHandler(previewEvent({ role: OrgRole.Member })),
    );

    expect(body).toMatchObject({ keys: [], survivingCount: 2 });
  });

  it('refuses a caller who could not make the change', async () => {
    // An Admin reaches Admin and below. Demoting an Owner is `owners.manage`,
    // and the preview names that Owner's access keys.
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET, role: OrgRole.Owner });

    const result = await baseHandler(
      previewEvent({ role: OrgRole.Member, callerRole: OrgRole.Admin }),
    );

    expect(result.statusCode).toBe(403);
    expect(bodyOf<ErrorResponse>(result).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('answers 404 for somebody who is not a member', async () => {
    stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET });

    expect((await baseHandler(previewEvent())).statusCode).toBe(404);
  });

  it('answers 400 without a userId in the path', async () => {
    expect((await baseHandler(previewEvent({ targetUserId: null }))).statusCode).toBe(400);
  });

  it.each(['', 'billing', 'OWNER'])('answers 400 for role=%s', async (role) => {
    expect((await baseHandler(previewEvent({ role }))).statusCode).toBe(400);
  });
});
