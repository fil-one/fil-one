import { describe, it, expect } from 'vitest';

import { S3Region, supportsBucketManagement } from '@filone/shared';

import { type ConnectionClient, getConnectionSnippets } from './connection-snippets.js';

const ENDPOINT = 'https://any-endpoint.example';
const snippets = getConnectionSnippets(S3Region.EuWest1, ENDPOINT);

/** Everything a reader pastes for one client, in order. */
function fullSnippet(client: ConnectionClient): string {
  const { setup, client: create, upload } = snippets[client];
  return [setup, create, upload].filter(Boolean).join('\n');
}

describe('getConnectionSnippets', () => {
  // Fil One serves path-style requests only, so a client on its
  // virtual-hosted default fails on the first call.
  it.each([
    ['cli', 'aws configure set default.s3.addressing_style path'],
    ['python', 'config=Config(s3={"addressing_style": "path"})'],
    ['nodejs', 'forcePathStyle: true'],
    ['go', 'o.UsePathStyle = true'],
  ] as const)('sets path-style addressing for %s', (client, setting) => {
    expect(fullSnippet(client)).toContain(setting);
  });

  it.each(['cli', 'python', 'nodejs', 'go'] as const)(
    'points %s at the region endpoint',
    (client) => {
      expect(fullSnippet(client)).toContain(ENDPOINT);
    },
  );

  it.each(['context', 'os', 'github.com/aws/aws-sdk-go-v2/credentials'])(
    'imports %s in Go, which the snippet calls into',
    (pkg) => {
      expect(snippets.go.client).toContain(`"${pkg}"`);
    },
  );

  it.each(['cli', 'python', 'nodejs', 'go'] as const)(
    'carries only placeholder credentials for %s',
    (client) => {
      expect(fullSnippet(client)).toMatch(/YOUR_ACCESS_KEY[\s\S]*YOUR_SECRET_KEY/);
    },
  );

  // Only some regions create a bucket over S3; everywhere else the console does.
  it.each([
    ['allows creating a bucket over S3', true],
    ['does not allow it', false],
  ] as const)('offers the CLI a bucket step only when the region %s', (_case, allowed) => {
    const region = Object.values(S3Region).find(
      (candidate) => supportsBucketManagement(candidate) === allowed,
    );
    if (!region) throw new Error('No region of this kind to test with');

    expect(getConnectionSnippets(region, ENDPOINT).cli.createBucket).toBe(
      allowed ? `aws s3 mb s3://my-bucket --endpoint-url ${ENDPOINT}` : undefined,
    );
  });

  it.each(['python', 'nodejs', 'go'] as const)(
    'leaves bucket creation out of %s, which the console covers',
    (client) => {
      expect(snippets[client].createBucket).toBeUndefined();
    },
  );
});
