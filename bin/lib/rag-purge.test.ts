import { describe, expect, it } from 'vitest';

import { isRagUserInfoRow, ragIndexerTablePrefix, ragVectorBucketName } from './rag-purge.ts';

describe('isRagUserInfoRow', () => {
  it.each([
    ['a RAG key', 'ORG#any-org', 'RAGKEY#any-key'],
    ['a RAG key lookup', 'RAGKEYHASH#any-hash', 'LOOKUP'],
    ['an org RAG config', 'ORG#any-org', 'RAGCONFIG'],
    ['a RAG allowlist grant', 'ALLOWLIST#any-person@example.com', 'RAG'],
  ])('purges %s', (_case, pk, sk) => {
    expect(isRagUserInfoRow(pk, sk)).toBe(true);
  });

  it.each([
    // The organizations beta grant shares the partition, under its own sort key.
    ['an organizations beta grant', 'ALLOWLIST#any-person@example.com', 'ORGS_BETA'],
    ['an S3 access key', 'ORG#any-org', 'ACCESSKEY#any-key'],
    ['an org profile', 'ORG#any-org', 'PROFILE'],
    ['an invitation token lookup', 'INVITETOKEN#any-hash', 'LOOKUP'],
  ])('keeps %s', (_case, pk, sk) => {
    expect(isRagUserInfoRow(pk, sk)).toBe(false);
  });
});

describe('the names a stage gave its RAG resources', () => {
  it('derives the vector bucket and the table prefix from the stage', () => {
    expect({
      bucket: ragVectorBucketName('any-stage'),
      tablePrefix: ragIndexerTablePrefix('any-stage'),
    }).toStrictEqual({
      bucket: 'filone-any-stage-rag-vectors',
      tablePrefix: 'filone-any-stage-RagIndexerTableTable',
    });
  });
});
