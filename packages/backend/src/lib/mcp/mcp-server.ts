import { listBucketsUnavailableMessage, roleHasPermission, S3Region } from '@filone/shared';
import type { JsonRpcOutcome, JsonRpcRequest } from './json-rpc.ts';
import { isRecord } from './json-rpc.ts';
import { listOrgBuckets } from './list-org-buckets.ts';
import type { UserInfo } from '../user-context.ts';

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
      properties: {
        region: {
          type: 'string',
          enum: Object.values(S3Region),
          description: 'Only buckets in this region.',
        },
      },
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

const REGIONS: readonly string[] = Object.values(S3Region);

/** list_buckets' arguments checked against its input schema, or what breaks it. */
function parseListBucketsArguments(args: unknown): { region?: string } | { problem: string } {
  if (!isRecord(args)) return { problem: 'arguments must be an object' };
  const unknown = Object.keys(args).filter((key) => key !== 'region');
  if (unknown.length > 0) return { problem: `unknown argument: ${unknown.join(', ')}` };
  const { region } = args;
  if (region === undefined) return {};
  if (typeof region !== 'string' || !REGIONS.includes(region)) {
    return { problem: `region must be one of ${REGIONS.join(', ')}` };
  }
  return { region };
}

async function callListBuckets({ caller, signal }: McpRequestContext, args: unknown = {}) {
  if (!caller.membership || !roleHasPermission(caller.membership.role, 'buckets.read')) {
    return buildToolResult(
      { message: 'Your role in this organization does not permit list_buckets.' },
      true,
    );
  }
  const parsed = parseListBucketsArguments(args);
  // A tool error rather than Invalid params, so the model can correct the call.
  if ('problem' in parsed) {
    return buildToolResult({ message: `Invalid arguments: ${parsed.problem}` }, true);
  }

  const { region } = parsed;
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
      if (params.name === 'list_buckets') return callListBuckets(context, params.arguments);
      return { error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } };
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${request.method}` } };
  }
}
