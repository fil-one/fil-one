import type { Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import type {
  DynamoDBClientResolvedConfig,
  ServiceInputTypes,
  ServiceOutputTypes,
} from '@aws-sdk/client-dynamodb';
import type { AwsStub } from 'aws-sdk-client-mock';
import type { OrgRole } from '@filone/shared';
import { OrgKeys } from '../lib/org-membership.js';
import type { AuthenticatedEvent, UserInfo } from '../lib/user-context.js';

/** What `mockClient(DynamoDBClient)` returns. */
export type DynamoMock = AwsStub<
  ServiceInputTypes,
  ServiceOutputTypes,
  DynamoDBClientResolvedConfig
>;

/**
 * Answer the OrgTable membership read `authMiddleware` makes on every
 * authenticated request. Without a `role` the row is absent, which the
 * transition fallback resolves as Owner — the stub then exists only so the
 * mocked client answers the read at all.
 */
export function stubMembershipRead(
  ddbMock: DynamoMock,
  { orgId, userId, role }: { orgId: string; userId: string; role?: OrgRole },
): void {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } },
    })
    .resolves(
      role
        ? {
            Item: {
              role: { S: role },
              joinedAt: { S: '2026-01-01T00:00:00.000Z' },
              source: { S: 'signup' },
            },
          }
        : {},
    );
}

type NormalizedHeaderEvent = {
  headers: Record<string, string>;
  rawHeaders: Record<string, string>;
};

type BuildEventUserInfo = Omit<UserInfo, 'emailVerified' | 'sub'> & {
  emailVerified?: boolean;
  sub?: string;
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
      ...(props?.userInfo
        ? {
            userInfo: {
              sub: 'auth0|test-sub-id',
              ...props.userInfo,
              emailVerified: props.userInfo.emailVerified ?? true,
            },
          }
        : {}),
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
