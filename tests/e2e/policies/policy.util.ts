import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { expect, request, type APIRequestContext, type APIResponse } from '@playwright/test';
import type {
  BucketPolicy,
  CreateAccessKeyResponse,
  GetBucketPolicyResponse,
  PolicyStatement,
} from '@filone/shared';

// Shared by the bucket policy specs, which run against a local stage whose
// `us-east-9` region serves the `iam` access model from a smelt network
// (tests/e2e/policies/README.md).

export const REGION = 'us-east-9';
export const S3_ENDPOINT = process.env.E2E_POLICY_S3_ENDPOINT ?? 'http://localhost:15130';
export const PAYLOAD = Buffer.from('policy-e2e');
export const SEEDED_KEY = 'seeded.txt';

export const STORAGE_STATE = {
  owner: '.auth/policy-owner.json',
  member: '.auth/policy-member.json',
} as const;
export type PolicyUser = keyof typeof STORAGE_STATE;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Run bin/e2e-register-policy-users.ts first.`);
  }
  return value;
}

export const credentials = (user: PolicyUser) => ({
  email: requireEnv(`E2E_POLICY_${user.toUpperCase()}_EMAIL`),
  password: requireEnv(`E2E_POLICY_${user.toUpperCase()}_PASSWORD`),
  userId: requireEnv(`E2E_POLICY_${user.toUpperCase()}_USER_ID`),
});

export function uniqueBucketName(label: string): string {
  return `pol-${label}-${randomUUID().slice(0, 8)}`;
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

  send(method: 'POST' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<APIResponse> {
    return this.ctx.fetch(`/api${path}`, { method, data, headers: this.headers(true) });
  }

  // ── Policy ───────────────────────────────────────────────────────

  getPolicy(bucket: string): Promise<APIResponse> {
    return this.get(`/buckets/${bucket}/policy?region=${REGION}`);
  }

  async readPolicy(bucket: string): Promise<GetBucketPolicyResponse> {
    const res = await this.getPolicy(bucket);
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as GetBucketPolicyResponse;
  }

  putPolicy(bucket: string, body: { policy: unknown; etag?: string }): Promise<APIResponse> {
    return this.send('PUT', `/buckets/${bucket}/policy?region=${REGION}`, body);
  }

  deletePolicy(bucket: string, etag?: string): Promise<APIResponse> {
    const query = etag ? `&etag=${encodeURIComponent(etag)}` : '';
    return this.send('DELETE', `/buckets/${bucket}/policy?region=${REGION}${query}`);
  }

  /** Replace the policy with `statement`, reading the ETag first. */
  async setStatements(bucket: string, statement: PolicyStatement[]): Promise<string> {
    const { etag } = await this.readPolicy(bucket);
    const res = await this.putPolicy(bucket, { policy: { statement }, etag });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { etag: string }).etag;
  }

  // ── Buckets and keys ─────────────────────────────────────────────

  async createBucket(bucket: string): Promise<void> {
    const res = await this.send('POST', '/buckets', { bucketName: bucket, region: REGION });
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

  async mintKey(): Promise<CreateAccessKeyResponse> {
    const res = await this.send('POST', '/access-keys', {
      keyName: `policy-e2e-${randomUUID().slice(0, 8)}`,
      region: REGION,
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as CreateAccessKeyResponse;
  }

  async deleteKey(id: string): Promise<void> {
    const res = await this.send('DELETE', `/access-keys/${id}`);
    expect([200, 204, 404], await res.text()).toContain(res.status());
  }

  dispose(): Promise<void> {
    return this.ctx.dispose();
  }
}

export function s3For(key: CreateAccessKeyResponse): S3Client {
  return new S3Client({
    endpoint: S3_ENDPOINT,
    region: REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey },
  });
}

/** The S3 error a call failed with, as `<status> <code>`, or `ok`. */
export async function outcome(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return 'ok';
  } catch (err) {
    if (err instanceof S3ServiceException) return `${err.$metadata.httpStatusCode} ${err.name}`;
    throw err;
  }
}

export const listObjects = (s3: S3Client, bucket: string) =>
  s3.send(new ListObjectsV2Command({ Bucket: bucket }));

export const putObject = (s3: S3Client, bucket: string, key: string) =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: PAYLOAD }));

export const deleteObject = (s3: S3Client, bucket: string, key: string) =>
  s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

export function ownersStatement(ownerId: string): PolicyStatement {
  return { sid: 'filone-owners', effect: 'allow', principal: [ownerId], action: ['s3:*'] };
}

export function allow(
  principal: PolicyStatement['principal'],
  action: PolicyStatement['action'],
  sid?: string,
): PolicyStatement {
  return { ...(sid ? { sid } : {}), effect: 'allow', principal, action };
}

export function deny(
  principal: PolicyStatement['principal'],
  action: PolicyStatement['action'],
  sid?: string,
): PolicyStatement {
  return { ...(sid ? { sid } : {}), effect: 'deny', principal, action };
}

/**
 * Empty and delete a bucket the suite created, whatever state a test left its
 * policy in: the owner's grant goes back first, so a fresh owner key can list
 * and delete what is left.
 */
export async function removeBucket(
  owner: ConsoleApi,
  ownerId: string,
  bucket: string,
): Promise<void> {
  const current = await owner.getPolicy(bucket);
  if (
    current.status() === 404 &&
    ((await current.json()) as { code?: string }).code !== 'POLICY_NOT_FOUND'
  ) {
    return; // Already gone.
  }
  const policy: BucketPolicy = { statement: [ownersStatement(ownerId)] };
  const etag = current.ok() ? ((await current.json()) as GetBucketPolicyResponse).etag : undefined;
  const put = await owner.putPolicy(bucket, { policy, etag });
  expect([200, 201], await put.text()).toContain(put.status());

  const key = await owner.mintKey();
  try {
    const s3 = s3For(key);
    const { Contents = [] } = await listObjects(s3, bucket);
    for (const { Key } of Contents) await deleteObject(s3, bucket, Key!);
  } finally {
    await owner.deleteKey(key.id);
  }
  const res = await owner.deleteBucket(bucket);
  expect([200, 204], await res.text()).toContain(res.status());
}
