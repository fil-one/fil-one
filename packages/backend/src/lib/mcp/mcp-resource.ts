import type { MiddlewareObj } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { ResponseBuilder } from '../response-builder.ts';

/**
 * The MCP endpoint's URL. It is also the audience of the access tokens the
 * endpoint accepts: MCP clients ask Auth0 for a token for this resource (RFC 8707).
 */
export function getMcpResourceUrl(): string {
  return process.env.MCP_RESOURCE_URL!;
}

/** RFC 9728: the well-known prefix at the resource's origin, followed by its path. */
export function getMcpResourceMetadataUrl(): string {
  const { origin, pathname } = new URL(getMcpResourceUrl());
  return `${origin}/.well-known/oauth-protected-resource${pathname}`;
}

/** The MCP routes stay dark until launch. Read per call so tests can flip it. */
export function isMcpEnabled(): boolean {
  return process.env.MCP_ENABLED === 'true';
}

/** Answers 404 ahead of everything else, sign-in included, while MCP is off. */
export function mcpEnabledMiddleware(): MiddlewareObj<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Error,
  Context
> {
  const before = (): APIGatewayProxyStructuredResultV2 | void =>
    isMcpEnabled() ? undefined : new ResponseBuilder().status(404).emptyBody().build();
  return { before };
}
