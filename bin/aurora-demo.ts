import {
  createClient as createPortalClient,
  getTenantsByTenantIdAccessKeys,
  getTenantsByTenantIdAccessKeysByAccessKeyId,
  putTenantsByTenantIdAccessKeys,
} from '../packages/aurora-portal-client/src/index.ts';

const tenantId = requireEnv('AURORA_TENANT_ID');
const portalApiKey = requireEnv('AURORA_PORTAL_TOKEN');

// ── Setup portal client ──────────────────────────────────────────────

const client = createPortalClient({
  baseUrl: 'https://api.portal.dev.aur.lu/api/v1',
  headers: { 'X-Api-Key': portalApiKey },
});

client.interceptors.request.use((request) => {
  console.error(`${request.method} ${request.url}`);
  console.error();
  return request;
});
client.interceptors.response.use((response) => {
  console.error(response.status, response.statusText);
  response.headers.forEach((value, name) => {
    console.error(`${name}: ${value}`);
  });
  console.error();
  return response;
});

// ── Step 1: Create an access key ─────────────────────────────────────

const keyName = 'duplicate-test-key-5';
const accessBody = {
  name: keyName,
  access: [
    'Default',
    'Read',
    'Write',
    'Delete',
    'List',
    'GetBucketVersioning',
    'GetBucketObjectLockConfiguration',
    'ListBucketVersions',
    'GetObjectVersion',
    'GetObjectRetention',
    'GetObjectLegalHold',
    'PutObjectRetention',
    'PutObjectLegalHold',
    'DeleteObjectVersion',
  ],
};

console.log('\n=== Creating access key (first attempt) ===');
const {
  data: data1,
  error: error1,
  response: response1,
} = await putTenantsByTenantIdAccessKeys({
  client,
  path: { tenantId },
  body: accessBody,
  throwOnError: false,
});

console.log('Status:', response1.status);
if (error1) {
  console.error('First creation failed:', JSON.stringify(error1, null, 2));
  process.exit(1);
}
console.log('First key created:', JSON.stringify(data1, null, 2));

// ── Step 2a: List all access keys ────────────────────────────────────

console.log('\n=== Listing access keys ===');
const { data: listData } = await getTenantsByTenantIdAccessKeys({
  client,
  path: { tenantId },
  throwOnError: false,
});
console.log('List response:', JSON.stringify(listData, null, 2));

// ── Step 2b: Get key by internal ID ──────────────────────────────────

const auroraKeyId = data1?.accessKey?.id;
console.log('\n=== Get key by internal id:', auroraKeyId, '===');
const { data: getById, response: getByIdResp } = await getTenantsByTenantIdAccessKeysByAccessKeyId({
  client,
  path: { tenantId, accessKeyId: auroraKeyId! },
  throwOnError: false,
});
console.log('Status:', getByIdResp.status);
console.log('Response:', JSON.stringify(getById, null, 2));

// ── Step 2c: Get key by S3 accessKeyId ───────────────────────────────

const s3KeyId = data1?.accessKey?.accessKeyId;
console.log('\n=== Get key by S3 accessKeyId:', s3KeyId, '===');
const { data: getByS3, response: getByS3Resp } = await getTenantsByTenantIdAccessKeysByAccessKeyId({
  client,
  path: { tenantId, accessKeyId: s3KeyId! },
  throwOnError: false,
});
console.log('Status:', getByS3Resp.status);
console.log('Response:', JSON.stringify(getByS3, null, 2));

// ── Step 2d: Duplicate creation attempt ──────────────────────────────

console.log('\n=== Creating access key with same name (second attempt) ===');
const {
  data: data2,
  error: error2,
  response: response2,
} = await putTenantsByTenantIdAccessKeys({
  client,
  path: { tenantId },
  body: accessBody,
  throwOnError: false,
});

console.log('Status:', response2.status);
if (error2) {
  console.error('Second creation error:', JSON.stringify(error2, null, 2));
  console.log('\nAurora REJECTS duplicate key names with status', response2.status);
} else {
  console.log('Second key created:', JSON.stringify(data2, null, 2));
  console.log('\nAurora ALLOWS duplicate key names (created two keys with same name)');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}
