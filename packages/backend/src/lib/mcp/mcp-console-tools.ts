import { RETENTION_DURATION_TYPES, RETENTION_MODES, S3Region } from '@filone/shared';
import { baseHandler as createBucket } from '../../handlers/create-bucket.ts';
import { baseHandler as deleteBucket } from '../../handlers/delete-bucket.ts';
import { baseHandler as getBucket } from '../../handlers/get-bucket.ts';
import { baseHandler as getMe } from '../../handlers/get-me.ts';
import { baseHandler as listAccessKeys } from '../../handlers/list-access-keys.ts';
import { baseHandler as listBuckets } from '../../handlers/list-buckets.ts';
import { baseHandler as presign } from '../../handlers/presign.ts';
import { AccessLevel } from '../../middleware/subscription-guard.ts';
import { isRecord } from './json-rpc.ts';
import type { ConsoleRouteCall, ConsoleRouteResult } from './mcp-console-route.ts';
import { listBucketObjects } from './mcp-list-objects.ts';
import type { ToolDefinition } from './mcp-tool-schema.ts';
import type { AuthenticatedEvent } from '../user-context.ts';

interface ConsoleToolBase {
  definition: ToolDefinition;
  /** The part of the answer the agent gets; the whole answer when absent. */
  toResult?(body: unknown, args: Record<string, unknown>): unknown;
}

/** A tool that runs a console route, so it answers as the console would. */
interface RouteTool extends ConsoleToolBase {
  /** The route to run for checked arguments. */
  toRouteCall(args: Record<string, unknown>): ConsoleRouteCall;
}

/** A tool the console has no route for, answering in a route's shape. */
interface DirectTool extends ConsoleToolBase {
  run(event: AuthenticatedEvent, args: Record<string, unknown>): Promise<ConsoleRouteResult>;
}

export type ConsoleTool = RouteTool | DirectTool;

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

const OBJECT_IN_BUCKET = {
  type: 'object',
  properties: {
    ...BUCKET_IN_REGION.properties,
    key: { type: 'string', description: 'The object key.' },
  },
  required: ['bucketName', 'region', 'key'],
  additionalProperties: false,
} as const;

const VERSION_ID = {
  type: 'string',
  description: 'A specific version of the object; the current one when left out.',
} as const;

/** One presign operation through the console's presign route, which checks the caller's role and bucket policies. */
function toPresignCall(
  op: Record<string, unknown>,
  args: Record<string, unknown>,
): ConsoleRouteCall {
  return {
    handler: 'presign',
    baseHandler: presign,
    // The route guards at read level and refuses write operations in a grace period itself.
    accessLevel: AccessLevel.Read,
    queryStringParameters: { region: String(args.region) },
    body: [{ bucket: args.bucketName, key: args.key, ...op }],
  };
}

/** The one signed URL the presign route answered with. */
function toSignedUrl(body: unknown) {
  return isRecord(body) && Array.isArray(body.items) ? body.items[0] : undefined;
}

/** What an upload's PUT must send: the content type the URL was signed with. */
function toUploadContentType(args: Record<string, unknown>): string {
  return typeof args.contentType === 'string' ? args.contentType : 'application/octet-stream';
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
  {
    definition: {
      name: 'list_objects',
      title: 'List objects',
      description:
        'List one page of the objects in a bucket: key, size, last modified and ETag. ' +
        'Pass nextToken back as continuationToken for the next page.',
      inputSchema: {
        type: 'object',
        properties: {
          ...BUCKET_IN_REGION.properties,
          prefix: { type: 'string', description: 'Only keys that start with this.' },
          maxKeys: { type: 'integer', description: 'At most this many objects (up to 1000).' },
          continuationToken: { type: 'string', description: 'nextToken from the page before.' },
        },
        required: ['bucketName', 'region'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    run: listBucketObjects,
  },
  {
    definition: {
      name: 'get_download_url',
      title: 'Get download URL',
      description:
        'A URL that downloads one object with a plain GET for the next 5 minutes. ' +
        'Fil One never reads the object; fetch the URL yourself.',
      inputSchema: {
        ...OBJECT_IN_BUCKET,
        properties: { ...OBJECT_IN_BUCKET.properties, versionId: VERSION_ID },
      },
      annotations: { readOnlyHint: true },
    },
    toRouteCall: (args) =>
      toPresignCall(
        { op: 'getObject', ...(args.versionId !== undefined && { versionId: args.versionId }) },
        args,
      ),
    toResult: toSignedUrl,
  },
  {
    definition: {
      name: 'get_upload_url',
      title: 'Get upload URL',
      description:
        'A URL that uploads one object with a PUT for the next 5 minutes, replacing any object ' +
        'at that key in an unversioned bucket. Send the headers returned with it.',
      inputSchema: {
        ...OBJECT_IN_BUCKET,
        properties: {
          ...OBJECT_IN_BUCKET.properties,
          contentType: {
            type: 'string',
            description: "The object's media type; application/octet-stream when left out.",
          },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    toRouteCall: (args) =>
      toPresignCall(
        {
          op: 'putObject',
          contentType: toUploadContentType(args),
          // The console records the uploaded file's name; an agent's is the key's last segment.
          fileName: String(args.key).split('/').at(-1),
        },
        args,
      ),
    toResult: (body, args) => ({
      ...toSignedUrl(body),
      headers: { 'Content-Type': toUploadContentType(args) },
    }),
  },
  {
    definition: {
      name: 'delete_object',
      title: 'Delete object',
      description:
        'A URL that deletes one object, or one version of it, with a DELETE for the next ' +
        '5 minutes. Nothing is deleted until you send it.',
      inputSchema: {
        ...OBJECT_IN_BUCKET,
        properties: { ...OBJECT_IN_BUCKET.properties, versionId: VERSION_ID },
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    toRouteCall: (args) =>
      toPresignCall(
        { op: 'deleteObject', ...(args.versionId !== undefined && { versionId: args.versionId }) },
        args,
      ),
    toResult: toSignedUrl,
  },
];
