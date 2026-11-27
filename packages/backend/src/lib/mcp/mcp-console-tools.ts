import { S3Region } from '@filone/shared';
import { baseHandler as getMe } from '../../handlers/get-me.ts';
import { baseHandler as listAccessKeys } from '../../handlers/list-access-keys.ts';
import { baseHandler as listBuckets } from '../../handlers/list-buckets.ts';
import { AccessLevel } from '../../middleware/subscription-guard.ts';
import { isRecord } from './json-rpc.ts';
import type { ConsoleRouteCall } from './mcp-console-route.ts';
import type { ToolDefinition } from './mcp-tool-schema.ts';

/** An MCP tool that runs a console route, so it answers as the console would. */
export interface ConsoleTool {
  definition: ToolDefinition;
  /** The route to run for checked arguments. */
  toRouteCall(args: Record<string, unknown>): ConsoleRouteCall;
  /** The part of the route's answer the agent gets; the whole answer when absent. */
  toResult?(body: unknown): unknown;
}

const REGION = {
  type: 'string',
  enum: Object.values(S3Region),
} as const;

/** Only the arguments given, as query parameters: every one a tool passes there is a string. */
function toQuery(args: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)]));
}

export const CONSOLE_TOOLS: ConsoleTool[] = [
  {
    definition: {
      name: 'list_buckets',
      title: 'List buckets',
      description:
        'List the Fil One buckets in your organization, with the region serving each. ' +
        'Optionally narrow to one region.',
      inputSchema: {
        type: 'object',
        properties: { region: { ...REGION, description: 'Only buckets in this region.' } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    toRouteCall: (args) => ({
      handler: 'list-buckets',
      baseHandler: listBuckets,
      accessLevel: AccessLevel.Read,
      queryStringParameters: toQuery(args),
    }),
  },
  {
    definition: {
      name: 'get_account',
      title: 'Get account',
      description:
        'Who you are signed in as in Fil One: your user, the organization the tools act in, ' +
        'your role there and the permissions it grants.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    toRouteCall: () => ({ handler: 'get-me', baseHandler: getMe, accessLevel: AccessLevel.Read }),
    toResult: (body) => {
      if (!isRecord(body)) return {};
      const { userId, email, emailVerified, orgId, orgName, role, permissions } = body;
      return { userId, email, emailVerified, orgId, orgName, role, permissions };
    },
  },
  {
    definition: {
      name: 'list_access_keys',
      title: 'List access keys',
      description:
        'List the S3 access keys in your organization that your role lets you see, without ' +
        'their secrets. Optionally narrow to one region or to keys that can reach one bucket.',
      inputSchema: {
        type: 'object',
        properties: {
          region: { ...REGION, description: 'Only keys for this region.' },
          bucket: { type: 'string', description: 'Only keys that can reach this bucket.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    toRouteCall: (args) => ({
      handler: 'list-access-keys',
      baseHandler: listAccessKeys,
      accessLevel: AccessLevel.Read,
      queryStringParameters: toQuery(args),
    }),
  },
];
