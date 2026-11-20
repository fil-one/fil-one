import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { resolveAuth0Domain } from '../lib/auth0-domain.ts';
import { getMcpResourceUrl, mcpEnabledMiddleware } from '../lib/mcp/mcp-resource.ts';
import { ResponseBuilder } from '../lib/response-builder.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

/**
 * OAuth protected-resource metadata (RFC 9728) for the MCP endpoint. An MCP
 * client reads it after a 401 to learn that Auth0, the console's own sign-in,
 * issues the tokens the endpoint accepts.
 */
export async function baseHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  return new ResponseBuilder()
    .status(200)
    .body({
      resource: getMcpResourceUrl(),
      authorization_servers: [`https://${resolveAuth0Domain(event)}/`],
      bearer_methods_supported: ['header'],
      resource_name: 'Fil One',
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(mcpEnabledMiddleware())
  .use(httpHeaderNormalizer())
  .use(errorHandlerMiddleware());
