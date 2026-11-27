import type { JsonRpcOutcome, JsonRpcRequest } from './json-rpc.ts';
import { isRecord } from './json-rpc.ts';
import { callConsoleRoute } from './mcp-console-route.ts';
import { CONSOLE_TOOLS, type ConsoleTool } from './mcp-console-tools.ts';
import { checkToolArguments } from './mcp-tool-schema.ts';
import type { AuthenticatedEvent } from '../user-context.ts';

/** Newest first; the first is offered when the client asks for one we do not speak. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const TOOLS = CONSOLE_TOOLS.map((tool) => tool.definition);

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

/** Runs a tool's console route as the caller, so the tool answers as the console would. */
async function callConsoleTool(tool: ConsoleTool, { event }: McpRequestContext, args: unknown) {
  const parsed = checkToolArguments(args, tool.definition.inputSchema);
  // A tool error rather than Invalid params, so the model can correct the call.
  if ('problem' in parsed) {
    return buildToolResult({ message: `Invalid arguments: ${parsed.problem}` }, true);
  }
  const { statusCode, body } =
    'run' in tool
      ? await tool.run(event, parsed.args)
      : await callConsoleRoute(event, tool.toRouteCall(parsed.args));
  // A tool error rather than a JSON-RPC error, so the model reads a refusal or
  // an outage instead of the client reporting a broken server.
  if (statusCode >= 300) {
    const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined;
    return buildToolResult({ message: message ?? `Fil One answered ${statusCode}.` }, true);
  }
  return buildToolResult(tool.toResult ? tool.toResult(body, parsed.args) : body);
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
      const tool = CONSOLE_TOOLS.find((candidate) => candidate.definition.name === params.name);
      if (tool) return callConsoleTool(tool, context, params.arguments);
      return { error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } };
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${request.method}` } };
  }
}
