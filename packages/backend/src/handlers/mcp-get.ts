import middy from '@middy/core';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { mcpEnabledMiddleware } from '../lib/mcp-resource.ts';
import { ResponseBuilder } from '../lib/response-builder.ts';

/**
 * A GET on the MCP endpoint asks for a server-sent event stream. The endpoint
 * is stateless and keeps none, which Streamable HTTP signals with a 405.
 */
export async function baseHandler(): Promise<APIGatewayProxyStructuredResultV2> {
  return new ResponseBuilder().status(405).header('Allow', 'POST').emptyBody().build();
}

export const handler = middy(baseHandler).use(mcpEnabledMiddleware());
