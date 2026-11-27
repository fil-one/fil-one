import { S3Region } from '@filone/shared';
import { baseHandler as listBuckets } from '../../handlers/list-buckets.ts';
import { AccessLevel } from '../../middleware/subscription-guard.ts';
import type { JsonRpcOutcome, JsonRpcRequest } from './json-rpc.ts';
import { isRecord } from './json-rpc.ts';
import { callConsoleRoute } from './mcp-console-route.ts';
import type { AuthenticatedEvent } from '../user-context.ts';

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

/** The MCP request, which carries who is asking and when it must give up. */
export interface McpRequestContext {
  event: AuthenticatedEvent;
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

/** Runs the console's bucket list route as the caller, so the tool answers as GET /api/buckets would. */
async function callListBuckets({ event }: McpRequestContext, args: unknown = {}) {
  const parsed = parseListBucketsArguments(args);
  // A tool error rather than Invalid params, so the model can correct the call.
  if ('problem' in parsed) {
    return buildToolResult({ message: `Invalid arguments: ${parsed.problem}` }, true);
  }

  const { statusCode, body } = await callConsoleRoute(event, {
    handler: 'list-buckets',
    baseHandler: listBuckets,
    accessLevel: AccessLevel.Read,
    ...(parsed.region && { queryStringParameters: { region: parsed.region } }),
  });
  // A tool error rather than a JSON-RPC error, so the model reads a refusal or
  // an outage instead of the client reporting a broken server.
  if (statusCode >= 300) {
    const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined;
    return buildToolResult({ message: message ?? `Fil One answered ${statusCode}.` }, true);
  }
  return buildToolResult(body);
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
