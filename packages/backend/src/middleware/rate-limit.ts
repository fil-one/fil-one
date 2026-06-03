import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { MiddlewareObj } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { ApiErrorCode, SubscriptionStatus } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';

export interface RateLimitConfig {
  /** Max operations per window for paid/active users. */
  limit: number;
  /** Max operations per window for trial users. */
  trialLimit: number;
  /** Window size in seconds. */
  windowSeconds: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  limit: 200,
  trialLimit: 60,
  windowSeconds: 60,
};

const dynamo = getDynamoClient();

function parseOpCount(body: string | undefined): number {
  if (!body) return 1;
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? Math.min(parsed.length, 10) : 1;
  } catch {
    return 1;
  }
}

export function rateLimitMiddleware(config: Partial<RateLimitConfig> = {}) {
  const { limit, trialLimit, windowSeconds } = { ...DEFAULT_CONFIG, ...config };

  const before = async (request: {
    event: APIGatewayProxyEventV2;
  }): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const event = request.event as AuthenticatedEvent;
    const { userId } = getUserInfo(event);
    const opCount = parseOpCount(event.body);

    const status = event.requestContext.subscriptionStatus;
    const isTrial = !status || status === SubscriptionStatus.Trialing;
    const effectiveLimit = isTrial ? trialLimit : limit;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowKey = Math.floor(nowSeconds / windowSeconds);

    let count: number;
    try {
      const result = await dynamo.send(
        new UpdateItemCommand({
          TableName: Resource.BillingTable.name,
          Key: {
            pk: { S: `RATELIMIT#presign#${userId}` },
            sk: { S: `WINDOW#${windowKey}` },
          },
          UpdateExpression: 'ADD #count :ops SET #ttl = if_not_exists(#ttl, :ttl)',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':ops': { N: String(opCount) },
            ':ttl': { N: String((windowKey + 2) * windowSeconds) },
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      count = parseInt(result.Attributes?.count?.N ?? '0', 10);
    } catch (err) {
      // Fail open — don't let a DynamoDB error block presign requests
      console.warn('[rate-limit] DynamoDB error, allowing request', { error: err });
      return;
    }

    if (count > effectiveLimit) {
      const retryAfter = (windowKey + 1) * windowSeconds - nowSeconds;
      const response = new ResponseBuilder()
        .status(429)
        .body<ErrorResponse>({
          message: `Rate limit exceeded. You can make up to ${effectiveLimit} presign operations per minute.`,
          code: ApiErrorCode.RATE_LIMIT_EXCEEDED,
        })
        .build();
      response.headers = { ...response.headers, 'Retry-After': String(retryAfter) };
      return response;
    }
  };

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}
