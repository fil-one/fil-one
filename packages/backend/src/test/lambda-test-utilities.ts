import type { Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type {
  DynamoDBClientResolvedConfig,
  ServiceInputTypes,
  ServiceOutputTypes,
} from '@aws-sdk/client-dynamodb';
import type { AwsStub } from 'aws-sdk-client-mock';
import { OrgRole } from '@filone/shared';
import { OrgKeys } from '../lib/org-membership.js';
import type { OrgMembership } from '../lib/org-membership.js';
import type { AuthenticatedEvent, UserInfo } from '../lib/user-context.js';

/** What `mockClient(DynamoDBClient)` returns. */
type DynamoMock = AwsStub<ServiceInputTypes, ServiceOutputTypes, DynamoDBClientResolvedConfig>;

export const STUB_JOINED_AT = '2026-01-01T00:00:00.000Z';

// The `sst` resource mock lives in ./sst-resource-mock.js, which imports
// nothing: a `vi.mock('sst', …)` factory reaching this module would read a
// binding that is still initializing, since this one imports `sst` transitively.

/**
 * Answer the OrgTable membership read `authMiddleware` makes on every
 * authenticated request. The role is required: a test that does not say which
 * role its caller holds is not describing a request the middleware can serve,
 * and absence is its own case — stub it with {@link stubAbsentMembershipRead}.
 */
export function stubMembershipRead(
  ddbMock: DynamoMock,
  { orgId, userId, role }: { orgId: string; userId: string; role: OrgRole },
): void {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } },
    })
    .resolves({
      Item: {
        pk: { S: OrgKeys.orgPk(orgId) },
        sk: { S: OrgKeys.memberSk(userId) },
        role: { S: role },
        joinedAt: { S: STUB_JOINED_AT },
        source: { S: 'signup' },
      },
    });
}

/**
 * The membership row `authMiddleware` would have attached for a caller in this
 * role — what a handler test hands to {@link buildEvent} when the role is the
 * point of the test.
 */
export function membershipFor(orgId: string, userId: string, role: OrgRole): OrgMembership {
  return { orgId, userId, role, joinedAt: STUB_JOINED_AT, source: 'signup' };
}

/** No membership row — the caller is not a member, and `authorize` refuses. */
export function stubAbsentMembershipRead(
  ddbMock: DynamoMock,
  { orgId, userId }: { orgId: string; userId: string },
): void {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } },
    })
    .resolves({});
}

/** Answer the inverse-item Query behind `MeResponse.memberships`. */
export function stubMembershipList(
  ddbMock: DynamoMock,
  {
    userId,
    orgs,
  }: { userId: string; orgs: Array<{ orgId: string; role: OrgRole; joinedAt?: string }> },
): void {
  ddbMock
    .on(QueryCommand, {
      TableName: 'OrgTable',
      ExpressionAttributeValues: {
        ':pk': { S: OrgKeys.userPk(userId) },
        ':skPrefix': { S: OrgKeys.membershipSkPrefix() },
      },
    })
    .resolves({
      Items: orgs.map((org) => ({
        pk: { S: OrgKeys.userPk(userId) },
        sk: { S: OrgKeys.membershipSk(org.orgId) },
        role: { S: org.role },
        joinedAt: { S: org.joinedAt ?? STUB_JOINED_AT },
      })),
    });
}

type NormalizedHeaderEvent = {
  headers: Record<string, string>;
  rawHeaders: Record<string, string>;
};

/**
 * How a test names the caller's membership.
 *
 * `'absent'` rather than `undefined`, because a conditional spread
 * (`...(role ? { membership } : {})`) turns "no membership" into "key not
 * present", and a fixture that reads absence off the key would then hand a
 * denial test the default Owner and pass for the wrong reason. The value has to
 * be said out loud.
 */
export const NO_MEMBERSHIP = 'absent';

type BuildEventUserInfo = Omit<UserInfo, 'emailVerified' | 'sub' | 'membership'> & {
  emailVerified?: boolean;
  sub?: string;
  /** The caller's row, or {@link NO_MEMBERSHIP} for a caller who has none. */
  membership?: OrgMembership | typeof NO_MEMBERSHIP;
};

interface BuildEventProps {
  body?: string;
  cookies?: string[];
  userInfo?: BuildEventUserInfo;
  queryStringParameters?: Record<string, string>;
  requestContext?: Partial<APIGatewayProxyEventV2['requestContext']>;
  rawPath?: string;
  method?: string;
}

/**
 * The `userInfo` a handler actually sees, which after enforcement always
 * carries a membership: a request whose caller has no row never reaches a
 * handler, because `authorize` refused it. Say nothing about membership and the
 * caller is an Owner — the role every existing account holds — so a test about
 * a handler's own logic says nothing about roles. Pass
 * {@link NO_MEMBERSHIP} to describe a caller with no row.
 *
 * That the gate is installed at all is not left to these fixtures: the manifest
 * coverage test proves every declared route composes `authorize`, and
 * authorize's own tests prove what each role may do.
 */
function buildUserInfo(userInfo: BuildEventUserInfo): UserInfo {
  const { membership, ...rest } = userInfo;
  const resolved =
    membership === undefined
      ? membershipFor(userInfo.orgId, userInfo.userId, OrgRole.Owner)
      : membership;

  return {
    sub: 'auth0|test-sub-id',
    ...rest,
    emailVerified: userInfo.emailVerified ?? true,
    ...(resolved === NO_MEMBERSHIP ? {} : { membership: resolved }),
  };
}

export function buildEvent(
  props: BuildEventProps & { userInfo: BuildEventUserInfo },
): AuthenticatedEvent & NormalizedHeaderEvent;
export function buildEvent(props?: BuildEventProps): APIGatewayProxyEventV2 & NormalizedHeaderEvent;
export function buildEvent(
  props?: BuildEventProps,
): APIGatewayProxyEventV2 & NormalizedHeaderEvent {
  return {
    version: '2.0',
    routeKey: 'GET /test',
    rawPath: props?.rawPath ?? '/test',
    rawQueryString: props?.queryStringParameters
      ? new URLSearchParams(props.queryStringParameters).toString()
      : '',
    headers: {},
    rawHeaders: {},
    ...(props?.body !== undefined && { body: props.body }),
    ...(props?.queryStringParameters && { queryStringParameters: props.queryStringParameters }),
    requestContext: {
      accountId: '123',
      apiId: 'abc',
      domainName: 'test.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'test',
      http: {
        method: props?.method ?? 'GET',
        path: props?.rawPath ?? '/test',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'GET /test',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 1704067200000,
      ...(props?.userInfo ? { userInfo: buildUserInfo(props.userInfo) } : {}),
      ...props?.requestContext,
    },
    isBase64Encoded: false,
    ...(props?.body !== undefined ? { body: props.body } : {}),
    ...(props?.cookies ? { cookies: props.cookies } : {}),
  } as unknown as APIGatewayProxyEventV2 & NormalizedHeaderEvent;
}

export function buildContext(props?: Partial<Context>): Context {
  const functionName = props?.functionName ?? 'test-function';
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName,
    functionVersion: '$LATEST',
    invokedFunctionArn: `arn:aws:lambda:us-east-1:123456789:function:${functionName}`,
    memoryLimitInMB: '128',
    awsRequestId: 'test-request-id',
    logGroupName: `/aws/lambda/${functionName}`,
    logStreamName: '2024/01/01/[$LATEST]abc123',
    getRemainingTimeInMillis: () => 5000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
    ...props,
  };
}

export function buildMiddyRequest<TResult = APIGatewayProxyResultV2>(
  event: APIGatewayProxyEventV2,
  overrides?: Partial<
    Request<APIGatewayProxyEventV2, TResult, Error, Context, Record<string, unknown>>
  >,
): Request<APIGatewayProxyEventV2, TResult, Error, Context, Record<string, unknown>> {
  return {
    event,
    context: {} as Context,
    response: undefined,
    error: undefined,
    internal: {},
    ...overrides,
  };
}
