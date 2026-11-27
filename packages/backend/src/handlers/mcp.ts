import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { buildJsonRpcResponse, isJsonRpcRequest, toJsonRpcResponse } from '../lib/mcp/json-rpc.ts';
import { mcpEnabledMiddleware } from '../lib/mcp/mcp-resource.ts';
import { SUPPORTED_PROTOCOL_VERSIONS, dispatchMcpRequest } from '../lib/mcp/mcp-server.ts';
import { ResponseBuilder } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { requireOrgMembershipMiddleware } from '../middleware/authorize.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { requestDeadlineMiddleware } from '../middleware/request-deadline.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

/**
 * MCP over Streamable HTTP, stateless: every request is one JSON-RPC message
 * answered with one JSON body, so no session or SSE stream is kept, which is
 * what a Lambda can serve.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  // Streamable HTTP: an unsupported version is a 400; a missing header means 2025-03-26.
  const version = event.headers['mcp-protocol-version'] ?? BATCHING_VERSION;
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return new ResponseBuilder()
      .status(400)
      .body({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${version}` },
      })
      .build();
  }

  let message: unknown;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString()
      : event.body;
    message = JSON.parse(raw ?? '');
  } catch {
    return buildJsonRpcResponse(null, { error: { code: -32700, message: 'Parse error' } });
  }
  // Only 2025-03-26 has batches; 2025-06-18 dropped them.
  const batch: unknown[] | undefined =
    Array.isArray(message) && message.length > 0 && version === BATCHING_VERSION
      ? message
      : undefined;
  const replies = (
    await Promise.all((batch ?? [message]).map((m) => answerMessage(m, event)))
  ).filter((reply) => reply !== undefined);
  if (replies.length === 0) return new ResponseBuilder().status(202).emptyBody().build();
  return new ResponseBuilder()
    .status(200)
    .body(batch ? replies : replies[0])
    .build();
}

const BATCHING_VERSION = '2025-03-26';

/** The JSON-RPC response to one message, or nothing for a notification. */
async function answerMessage(message: unknown, event: AuthenticatedEvent) {
  if (!isJsonRpcRequest(message)) {
    return toJsonRpcResponse(null, { error: { code: -32600, message: 'Invalid Request' } });
  }
  // A notification or a client's response to us expects no reply.
  if (message.id === undefined) return undefined;
  return toJsonRpcResponse(message.id, await dispatchMcpRequest(message, { event }));
}

// Each tool checks its own permission, so the chain gates on membership only.
export const handler = middy(baseHandler)
  .use(mcpEnabledMiddleware())
  .use(requestDeadlineMiddleware())
  .use(httpHeaderNormalizer())
  .use(authMiddleware({ bearerToken: true }))
  .use(requireOrgMembershipMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
