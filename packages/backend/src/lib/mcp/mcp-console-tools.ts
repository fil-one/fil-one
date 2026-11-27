import { RETENTION_DURATION_TYPES, RETENTION_MODES, S3Region } from '@filone/shared';
import { baseHandler as createBucket } from '../../handlers/create-bucket.ts';
import { baseHandler as deleteBucket } from '../../handlers/delete-bucket.ts';
import { baseHandler as getBucket } from '../../handlers/get-bucket.ts';
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
  toResult?(body: unknown, args: Record<string, unknown>): unknown;
}

const REGION = {
  type: 'string',
  enum: Object.values(S3Region),
} as const;

const BUCKET_IN_REGION = {
  type: 'object',
  properties: {
    bucketName: { type: 'string', description: 'The bucket.' },
    region: { ...REGION, description: 'The region the bucket is in.' },
  },
  required: ['bucketName', 'region'],
  additionalProperties: false,
} as const;

/** The bucket a tool addresses, as a bucket route takes it: its name in the path, its region in the query. */
function toBucketAddress(args: Record<string, unknown>) {
  return {
    pathParameters: { name: String(args.bucketName) },
    queryStringParameters: { region: String(args.region) },
  };
}

/** create_bucket's flat arguments as the console's create request, with retention as its object. */
function toCreateBucketRequest(args: Record<string, unknown>) {
  const { retentionMode, retentionDuration, retentionDurationType, ...request } = args;
  // Any one of them asks for retention; the route refuses a set that is not whole.
  if ([retentionMode, retentionDuration, retentionDurationType].every((v) => v === undefined)) {
    return request;
  }
  return {
    ...request,
    retention: {
      enabled: true,
      mode: retentionMode,
      duration: retentionDuration,
      durationType: retentionDurationType,
    },
  };
}

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
  {
    definition: {
      name: 'get_bucket',
      title: 'Get bucket',
      description:
        'Read one bucket: whether it is public, versioning, Object Lock and default retention.',
      inputSchema: BUCKET_IN_REGION,
      annotations: { readOnlyHint: true },
    },
    toRouteCall: (args) => ({
      handler: 'get-bucket',
      baseHandler: getBucket,
      accessLevel: AccessLevel.Read,
      ...toBucketAddress(args),
    }),
  },
  {
    definition: {
      name: 'create_bucket',
      title: 'Create bucket',
      description:
        'Create a bucket. Versioning and Object Lock can only be set now, not changed later; ' +
        'Object Lock needs versioning, and default retention needs Object Lock.',
      inputSchema: {
        type: 'object',
        properties: {
          bucketName: {
            type: 'string',
            description:
              'Lowercase letters, numbers and hyphens, starting and ending with a letter or number.',
          },
          region: { ...REGION, description: 'The region to create the bucket in.' },
          versioning: { type: 'boolean', description: 'Keep every version of each object.' },
          lock: { type: 'boolean', description: 'Turn on Object Lock (WORM).' },
          retentionMode: {
            type: 'string',
            enum: RETENTION_MODES,
            description:
              'Default retention mode for new objects. Leave out for no default retention.',
          },
          retentionDuration: { type: 'integer', description: 'Default retention length.' },
          retentionDurationType: {
            type: 'string',
            enum: RETENTION_DURATION_TYPES,
            description: 'Whether the retention length is in days (d) or years (y).',
          },
        },
        required: ['bucketName', 'region'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    toRouteCall: (args) => ({
      handler: 'create-bucket',
      baseHandler: createBucket,
      accessLevel: AccessLevel.Write,
      body: toCreateBucketRequest(args),
    }),
  },
  {
    definition: {
      name: 'delete_bucket',
      title: 'Delete bucket',
      description:
        'Delete an empty bucket. A bucket that still holds objects or object versions is refused.',
      inputSchema: BUCKET_IN_REGION,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    toRouteCall: (args) => ({
      handler: 'delete-bucket',
      baseHandler: deleteBucket,
      accessLevel: AccessLevel.Write,
      ...toBucketAddress(args),
    }),
    toResult: (_body, args) => ({ deleted: args.bucketName }),
  },
];
