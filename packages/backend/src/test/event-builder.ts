import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { Event as NormalizedHeaderEvent } from '@middy/http-header-normalizer';
import type { AuthenticatedEvent, UserInfo } from '../lib/user-context.js';

export class EventBuilder {
  private _cookies: string[] | undefined;
  private _userInfo: UserInfo | undefined;
  private _queryStringParameters: Record<string, string> | undefined;

  withCookies(cookies: string[]): this {
    this._cookies = cookies;
    return this;
  }

  withUserId(userId: string, email = 'test@test.com'): this {
    this._userInfo = { userId, email };
    return this;
  }

  withQueryStringParameters(params: Record<string, string>): this {
    this._queryStringParameters = params;
    return this;
  }

  build(): APIGatewayProxyEventV2 & NormalizedHeaderEvent {
    return {
      version: '2.0',
      routeKey: 'GET /test',
      rawPath: '/test',
      rawQueryString: this._queryStringParameters
        ? new URLSearchParams(this._queryStringParameters).toString()
        : '',
      headers: {},
      rawHeaders: {},
      ...(this._queryStringParameters && { queryStringParameters: this._queryStringParameters }),
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
        ...(this._userInfo ? { userInfo: this._userInfo } : {}),
      },
      isBase64Encoded: false,
      ...(this._cookies ? { cookies: this._cookies } : {}),
    } as unknown as APIGatewayProxyEventV2 & NormalizedHeaderEvent;
  }
}
