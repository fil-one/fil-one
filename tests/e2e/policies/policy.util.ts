import { randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  expect,
  request,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import {
  POLICY_VERSION,
  CREATOR_ACTIONS,
  S3Region,
  getS3Endpoint,
  getStatementResources,
  toPolicyPrincipal,
} from '@filone/shared';
import type {
  BucketPolicy,
  CreateAccessKeyResponse,
  GetBucketPolicyResponse,
  PolicyStatement,
} from '@filone/shared';

// Shared by the bucket policy specs. They run against any stage whose Forge
// region serves the `iam` access model: locally that is `us-east-9` from a
// smelt network, on a remote stage `eu-central-3` (tests/e2e/policies/README.md).

const STAGE = process.env.SST_STAGE ?? (process.env.LOCAL ? 'local' : 'staging');
export const REGION =
  (process.env.E2E_POLICY_REGION as S3Region | undefined) ??
  (STAGE === 'local' ? S3Region.UsEast9 : S3Region.EuCentral3);
export const S3_ENDPOINT =
  process.env.E2E_POLICY_S3_ENDPOINT ??
  (STAGE === 'local' ? 'http://localhost:15130' : getS3Endpoint(REGION, STAGE));
export const PAYLOAD = Buffer.from('policy-e2e');
export const SEEDED_KEY = 'seeded.txt';

export const STORAGE_STATE = {
  owner: '.auth/policy-owner.json',
  admin: '.auth/policy-admin.json',
  member: '.auth/policy-member.json',
  readonly: '.auth/policy-readonly.json',
  leaver: '.auth/policy-leaver.json',
} as const;
export type PolicyUser = keyof typeof STORAGE_STATE;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Run bin/e2e-register-policy-users.ts first.`);
  }
  return value;
}

export const getCredentials = (user: PolicyUser) => ({
  email: requireEnv(`E2E_POLICY_${user.toUpperCase()}_EMAIL`),
  password: requireEnv(`E2E_POLICY_${user.toUpperCase()}_PASSWORD`),
  userId: requireEnv(`E2E_POLICY_${user.toUpperCase()}_USER_ID`),
});

export function generateBucketName(prefix: string): string {
  return `pol-${prefix}-${randomUUID().slice(0, 8)}`;
}

/** A console API session for one user, acting in `orgId`. */
export class ConsoleApi {
  private readonly ctx: APIRequestContext;
  private readonly orgId: string;
  private readonly csrf: string;

  private constructor(ctx: APIRequestContext, orgId: string, csrf: string) {
    this.ctx = ctx;
    this.orgId = orgId;
    this.csrf = csrf;
  }

  static async open(user: PolicyUser, orgId: string): Promise<ConsoleApi> {
    const ctx = await request.newContext({
      baseURL: process.env.BASE_URL,
      ignoreHTTPSErrors: true,
      storageState: STORAGE_STATE[user],
    });
    const { cookies } = await ctx.storageState();
    const csrf = cookies.find((c) => c.name === 'hs_csrf_token')?.value ?? '';
    return new ConsoleApi(ctx, orgId, csrf);
  }

  private headers(write: boolean): Record<string, string> {
    return { 'X-Org-Id': this.orgId, ...(write ? { 'x-csrf-token': this.csrf } : {}) };
  }

  get(path: string): Promise<APIResponse> {
    return this.ctx.get(`/api${path}`, { headers: this.headers(false) });
  }

  send(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ): Promise<APIResponse> {
    return this.ctx.fetch(`/api${path}`, {
      method,
      data,
      headers: { ...this.headers(true), ...headers },
    });
  }

  // ── Policy ───────────────────────────────────────────────────────

  fetchPolicyResponse(bucket: string): Promise<APIResponse> {
    return this.get(`/buckets/${bucket}/policy?region=${REGION}`);
  }

  /** The policy with the ETag its response header carried. */
  async readPolicy(bucket: string): Promise<GetBucketPolicyResponse & { etag: string }> {
    const res = await this.fetchPolicyResponse(bucket);
    expect(res.status(), await res.text()).toBe(200);
    const { policy } = (await res.json()) as GetBucketPolicyResponse;
    return { policy, etag: res.headers().etag! };
  }

  /**
   * `etag` goes out as `If-Match`; without one the write creates the first
   * policy (`If-None-Match: *`) unless `unconditional`.
   */
  putPolicy(
    bucket: string,
    { policy, etag, unconditional }: { policy: unknown; etag?: string; unconditional?: boolean },
  ): Promise<APIResponse> {
    const precondition: Record<string, string> = etag
      ? { 'If-Match': etag }
      : unconditional
        ? {}
        : { 'If-None-Match': '*' };
    return this.send('PUT', `/buckets/${bucket}/policy?region=${REGION}`, { policy }, precondition);
  }

  /** Under `If-Match` when `etag` is given, unconditional otherwise. */
  deletePolicy(bucket: string, etag?: string): Promise<APIResponse> {
    return this.send(
      'DELETE',
      `/buckets/${bucket}/policy?region=${REGION}`,
      undefined,
      etag ? { 'If-Match': etag } : {},
    );
  }

  /** Replace the policy with `statements`, reading the ETag first. Returns the new ETag. */
  async replaceStatements(
    bucket: string,
    statements: readonly UnboundStatement[],
  ): Promise<string> {
    const { etag } = await this.readPolicy(bucket);
    const res = await this.putPolicy(bucket, { policy: bindToBucket(bucket, statements), etag });
    expect(res.status(), await res.text()).toBe(204);
    return res.headers().etag!;
  }

  // ── Buckets and keys ─────────────────────────────────────────────

  async createBucket(bucket: string, { versioning = false, lock = false } = {}): Promise<void> {
    const res = await this.send('POST', '/buckets', {
      bucketName: bucket,
      region: REGION,
      versioning: versioning || lock,
      lock,
    });
    expect(res.status(), await res.text()).toBe(201);
  }

  deleteBucket(bucket: string): Promise<APIResponse> {
    return this.send('DELETE', `/buckets/${bucket}?region=${REGION}`);
  }

  async listBucketNames(): Promise<string[]> {
    const res = await this.get(`/buckets?region=${REGION}`);
    expect(res.status(), await res.text()).toBe(200);
    const { buckets } = (await res.json()) as { buckets: { bucketName: string }[] };
    return buckets.map((b) => b.bucketName);
  }

  async createAccessKey(): Promise<CreateAccessKeyResponse> {
    const res = await this.send('POST', '/access-keys', {
      keyName: `policy-e2e-${randomUUID().slice(0, 8)}`,
      region: REGION,
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as CreateAccessKeyResponse;
  }

  /** The ids of the keys this user sees, which for a Member or below is their own. */
  async listKeyIds(): Promise<string[]> {
    const res = await this.get('/access-keys');
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { keys: { id: string }[] }).keys.map((k) => k.id);
  }

  async deleteKey(id: string): Promise<void> {
    const res = await this.send('DELETE', `/access-keys/${id}`);
    expect([200, 204, 404], await res.text()).toContain(res.status());
  }

  rotateKey(id: string): Promise<APIResponse> {
    return this.send('POST', `/access-keys/${id}/rotate`);
  }

  // ── Members ──────────────────────────────────────────────────────

  setRole(userId: string, role: 'admin' | 'member'): Promise<APIResponse> {
    return this.send('PATCH', `/org/members/${userId}`, { role });
  }

  removeMember(userId: string): Promise<APIResponse> {
    return this.send('DELETE', `/org/members/${userId}`);
  }

  dispose(): Promise<void> {
    return this.ctx.dispose();
  }
}

export function createS3Client(key: CreateAccessKeyResponse): S3Client {
  return new S3Client({
    endpoint: S3_ENDPOINT,
    region: REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey },
  });
}

/** The S3 error a call failed with, as `<status> <code>`, or `ok`. */
export async function getS3Outcome(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return 'ok';
  } catch (err) {
    if (err instanceof S3ServiceException) return `${err.$metadata.httpStatusCode} ${err.name}`;
    throw err;
  }
}

/** A client signed with a new key of `api`'s user, recorded in `createdKeys` for cleanup. */
export async function createS3ClientWithNewKey(
  api: ConsoleApi,
  createdKeys: { api: ConsoleApi; id: string }[],
): Promise<S3Client> {
  const key = await api.createAccessKey();
  createdKeys.push({ api, id: key.id });
  return createS3Client(key);
}

export const listObjects = (s3: S3Client, bucket: string) =>
  s3.send(new ListObjectsV2Command({ Bucket: bucket }));

export const putObject = (s3: S3Client, bucket: string, key: string) =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: PAYLOAD }));

export const deleteObject = (s3: S3Client, bucket: string, key: string) =>
  s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

/**
 * A statement before it names the bucket it is written to. The builders below
 * make these from member ids; {@link bindToBucket} fills in Resource once the
 * bucket is known.
 */
export type UnboundStatement = Omit<PolicyStatement, 'Resource'>;

/** The statement with the Resource its actions need on `bucket`. */
export function bindStatement(bucket: string, statement: UnboundStatement): PolicyStatement {
  return { ...statement, Resource: getStatementResources(bucket, statement.Action) };
}

/** The document the statements make on `bucket`. */
export function bindToBucket(
  bucket: string,
  statements: readonly UnboundStatement[],
): BucketPolicy {
  return { Version: POLICY_VERSION, Statement: statements.map((st) => bindStatement(bucket, st)) };
}

/** The statement a new bucket carries: its creator, with every action but the retention writes. */
export function buildCreatorStatement(creatorId: string): UnboundStatement {
  return allow([creatorId], CREATOR_ACTIONS, 'creator');
}

/** What a new bucket carries, whoever created it. */
export function buildCreatorPolicy(bucket: string, creatorId: string): BucketPolicy {
  return bindToBucket(bucket, [buildCreatorStatement(creatorId)]);
}

/** Every action for the owner under an ordinary Sid: what most cases start their policy from. */
export function grantAllToOwner(ownerId: string): UnboundStatement {
  return allow([ownerId], ['s3:*'], 'owner-all');
}

export function allow(
  principal: '*' | string[],
  action: PolicyStatement['Action'],
  sid?: string,
): UnboundStatement {
  return {
    ...(sid ? { Sid: sid } : {}),
    Effect: 'Allow',
    Principal: toPolicyPrincipal(principal),
    Action: action,
  };
}

export function deny(
  principal: '*' | string[],
  action: PolicyStatement['Action'],
  sid?: string,
): UnboundStatement {
  return { ...allow(principal, action, sid), Effect: 'Deny' };
}

/**
 * Empty and delete a bucket the suite created, whatever state a test left its
 * policy in: the owner's grant goes back first, so a fresh owner key can list
 * and delete what is left.
 */
export async function emptyAndDeleteBucket(
  owner: ConsoleApi,
  ownerId: string,
  bucket: string,
): Promise<void> {
  const current = await owner.fetchPolicyResponse(bucket);
  if (
    current.status() === 404 &&
    ((await current.json()) as { code?: string }).code !== 'POLICY_NOT_FOUND'
  ) {
    return; // Already gone.
  }
  const policy = bindToBucket(bucket, [grantAllToOwner(ownerId)]);
  const etag = current.ok() ? current.headers().etag : undefined;
  const put = await owner.putPolicy(bucket, { policy, etag });
  expect(put.status(), await put.text()).toBe(204);

  const key = await owner.createAccessKey();
  try {
    const s3 = createS3Client(key);
    // Every version and delete marker, so a versioned bucket empties too, and
    // any upload a test left open.
    const { Versions = [], DeleteMarkers = [] } = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket }),
    );
    // An unversioned bucket lists its objects under the literal version "null",
    // which a gateway may refuse as a version-scoped delete; only a suspended
    // bucket needs it kept (as packages/backend/src/lib/s3-bulk-delete.ts does).
    const { Status } = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    for (const { Key, VersionId } of [...Versions, ...DeleteMarkers]) {
      const scoped = VersionId !== 'null' || Status === 'Suspended';
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key, ...(scoped && { VersionId }) }));
    }
    const { Uploads = [] } = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    for (const { Key, UploadId } of Uploads) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key, UploadId }));
    }
  } finally {
    await owner.deleteKey(key.id);
  }
  const res = await owner.deleteBucket(bucket);
  expect([200, 204], await res.text()).toContain(res.status());
}

/**
 * A policy in the form the storage system stores it: the statement, principal,
 * action and resource lists are sets, so each is sorted and deduplicated and
 * the statements are ordered by their encoding. Compare policies through this,
 * since a read comes back canonical whatever order a write sent.
 */
export function toCanonicalPolicy(policy: BucketPolicy): BucketPolicy {
  const set = (values: readonly string[]) => [...new Set(values)].sort();
  const statement = policy.Statement.map((st) => ({
    ...st,
    Principal: st.Principal === '*' ? st.Principal : { AWS: set(st.Principal.AWS) },
    Action: set(st.Action),
    Resource: set(st.Resource),
  }));
  statement.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { ...policy, Statement: statement } as BucketPolicy;
}

/**
 * Edit or remove a statement card from its overflow menu. The menu panel is
 * portalled out of the card, so the item is found from the page.
 */
export async function chooseStatementMenuAction(
  page: Page,
  title: string,
  action: 'edit' | 'remove',
): Promise<void> {
  await page
    .locator(`[data-testid="policy-statement"][data-statement-title="${title}"]`)
    .getByTestId('policy-statement-actions')
    .click();
  await page.getByTestId(`policy-statement-${action}`).click();
}
