#!/usr/bin/env node

// Create a pre-signed GetObject URL for a customer object stored in the Aurora
// region (eu-west-1), valid for 24 hours.
//
// Usage:
//   node bin/aurora-preview-url.ts <auroraTenantId> <bucket> <objectKey>
//   node bin/aurora-preview-url.ts f6d6ca47-d220-4da4-b2c5-87f5ae838ce8 amazon-ese VerifiedSNew.html
//
// The tenant id is Aurora's, not the Fil One org id — take it from the Aurora
// Back Office dashboard, or map an org id to it with bin/aurora-s3-env.ts.
//
// The stage defaults to `production`; set STAGE to target another one. The
// object key is passed through verbatim, so a leading slash is preserved.
//
// Works in production: no `sst shell` (it can't evaluate pulumi providers
// there). Talks to AWS directly using your ambient AWS credentials
// (env vars / SSO / profile), so make sure they target the right account
// before running.
//
// The URL is bearer authority for its whole lifetime: anyone holding it can
// read the object until it expires.

import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const USAGE = 'Usage: node bin/aurora-preview-url.ts <auroraTenantId> <bucket> <objectKey>';

const EXPIRES_IN_SECONDS = 24 * 60 * 60;

const tenantId = process.argv[2];
const bucketName = process.argv[3];
const objectKey = process.argv[4];

if (!tenantId || !bucketName || !objectKey) {
  console.error(USAGE);
  process.exit(1);
}

// The AWS SDK resolves credentials from the profile; without it the SSM call
// fails late with an unhelpful CredentialsProviderError.
if (!process.env.AWS_PROFILE) {
  console.error(
    'AWS_PROFILE is not set. Log in and activate the profile first (see README.md):\n' +
      '  aws sso login --profile filone\n' +
      '  export AWS_PROFILE=filone',
  );
  process.exit(1);
}

const stage = process.env.STAGE ?? 'production';
const isProduction = stage === 'production';

console.error(`Stage: ${stage}`);
console.error(`Tenant ID: ${tenantId}`);
console.error(`Bucket: ${bucketName}`);

const url = await presignGetObject();
console.error(`Expires: ${new Date(Date.now() + EXPIRES_IN_SECONDS * 1000).toISOString()}`);
console.log(url);

async function presignGetObject(): Promise<string> {
  // Bin scripts must not import from @filone/shared, so the Aurora endpoints
  // are inlined — keep them in sync with getS3Endpoint in
  // packages/shared/src/constants.ts.
  const endpoint = isProduction ? 'https://eu-west-1.s3.fil.one' : 'https://s3.dev.aur.lu';
  console.error(`Endpoint: ${endpoint}`);

  const s3 = new S3Client({
    endpoint,
    // Aurora signs with "auto"; the signing region is part of the signature, so
    // any other value produces URLs that 403.
    region: 'auto',
    credentials: await readConsoleS3Credentials(),
    forcePathStyle: true,
    // Match packages/backend/src/lib/s3-client.ts: no auto-added CRC32 checksum
    // params in the signed query string.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  // Fail fast on a wrong key: presigning is a local signature computation and
  // would happily produce a URL that 404s when opened.
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: objectKey }));
  } catch (err) {
    if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      console.error(`Object "${objectKey}" does not exist in bucket "${bucketName}".`);
      process.exit(1);
    }
    // The gateway may restrict HEAD for this key; presign anyway.
    console.error('Warning: could not verify the object exists (HeadObject failed):', err);
  }

  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: objectKey }), {
    expiresIn: EXPIRES_IN_SECONDS,
  });
}

// The console's S3 access key for the tenant, stashed during tenant setup — see
// packages/backend/src/lib/s3-credentials.ts for the path scheme.
async function readConsoleS3Credentials(): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
}> {
  // The deployment home region is fixed for production/staging (see
  // sst.config.ts); dev stages can deploy anywhere.
  const awsRegion =
    stage === 'production' || stage === 'staging'
      ? 'us-east-2'
      : (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2');
  const ssm = new SSMClient({ region: awsRegion });

  const parameterName = `/filone/${stage}/aurora-s3/access-key/${tenantId}`;

  let value: string | undefined;
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
    );
    value = Parameter?.Value;
  } catch (err) {
    // A wrong or non-Aurora tenant id is the most likely user error now that
    // the tenant id is a raw argument.
    if ((err as { name?: string }).name === 'ParameterNotFound') {
      console.error(
        `No S3 credentials found in SSM at ${parameterName} — ` +
          `is "${tenantId}" an Aurora tenant id on stage "${stage}"?`,
      );
      process.exit(1);
    }
    throw err;
  }
  if (!value) {
    console.error(`No S3 credentials found in SSM at ${parameterName}.`);
    process.exit(1);
  }

  return JSON.parse(value);
}
