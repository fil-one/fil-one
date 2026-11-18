import { listBucketsUnavailableMessage } from '@filone/shared';
import type { JsonRpcOutcome, JsonRpcRequest } from './json-rpc.ts';
import { isRecord } from './json-rpc.ts';
import { listOrgBuckets } from './list-org-buckets.ts';
import type { UserInfo } from './user-context.ts';

/** Newest first; the first is offered when the client asks for one we do not speak. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const TOOLS = [
  {
    name: 'list_buckets',
    title: 'List buckets',
    description:
      'List the Fil One buckets in your organization, with the region serving each. ' +
      'Optionally narrow to one region.',
    inputSchema: {
      type: 'object',
      properties: { region: { type: 'string', description: 'Only buckets in this region.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

/** Who is asking, and when the request must give up. */
export interface McpRequestContext {
  caller: UserInfo;
  signal: AbortSignal;
}

function buildToolResult(payload: unknown, isError = false) {
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      ...(isError ? { isError } : { structuredContent: payload }),
    },
  };
}

async function callListBuckets(
  { caller, signal }: McpRequestContext,
  args: Record<string, unknown>,
) {
  const region = typeof args.region === 'string' ? args.region : undefined;
  const { buckets, unavailableRegions, allFailed } = await listOrgBuckets(caller, {
    region,
    signal,
  });
  // A tool error rather than a JSON-RPC error, so the model reads the outage
  // instead of the client reporting a broken server.
  if (allFailed) {
    return buildToolResult({ message: listBucketsUnavailableMessage(unavailableRegions) }, true);
  }
  return buildToolResult({
    buckets,
    ...(unavailableRegions.length > 0 && { unavailableRegions }),
  });
}

/** Answer one MCP request. Notifications expect no reply and never reach here. */
export async function dispatchMcpRequest(
  request: JsonRpcRequest,
  context: McpRequestContext,
): Promise<JsonRpcOutcome> {
  const params = request.params ?? {};
  switch (request.method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested);
      return {
        result: {
          protocolVersion: protocolVersion ?? SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'fil-one', version: '0.1.0' },
        },
      };
    }
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: TOOLS } };
    case 'tools/call': {
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (params.name === 'list_buckets') return callListBuckets(context, args);
      return { error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } };
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${request.method}` } };
  }
}
