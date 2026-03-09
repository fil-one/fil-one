import type { Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import type { AuthenticatedEvent, UserInfo } from '../lib/user-context.js';

type NormalizedHeaderEvent = { headers: Record<string, string>; rawHeaders: Record<string, string> };

interface BuildEventProps {
  cookies?: string[];
  userInfo?: UserInfo;
  queryStringParameters?: Record<string, string>;
  requestContext?: Partial<APIGatewayProxyEventV2['requestContext']>;
}

export function buildEvent(props: BuildEventProps & { userInfo: UserInfo }): AuthenticatedEvent & NormalizedHeaderEvent;
export function buildEvent(props?: BuildEventProps): APIGatewayProxyEventV2 & NormalizedHeaderEvent;
export function buildEvent(props?: BuildEventProps): APIGatewayProxyEventV2 & NormalizedHeaderEvent {
  return {
    version: '2.0',
    routeKey: 'GET /test',
    rawPath: '/test',
    rawQueryString: props?.queryStringParameters
      ? new URLSearchParams(props.queryStringParameters).toString()
      : '',
    headers: {},
    rawHeaders: {},
    ...(props?.queryStringParameters && { queryStringParameters: props.queryStringParameters }),
    requestContext: {
      accountId: '123',
      apiId: 'abc',
      domainName: 'test.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'test',
      http: { method: 'GET', path: '/test', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /test',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 1704067200000,
      ...(props?.userInfo ? { userInfo: props.userInfo } : {}),
      ...props?.requestContext,
    },
    isBase64Encoded: false,
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
  overrides?: Partial<Request<APIGatewayProxyEventV2, TResult, Error, Context, Record<string, unknown>>>,
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
