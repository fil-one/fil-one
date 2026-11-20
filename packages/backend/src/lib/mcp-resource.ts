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
