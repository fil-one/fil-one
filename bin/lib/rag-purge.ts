// What bin/purge-rag-data.ts deletes, decided without AWS so it can be tested.
//
// Bucket Intelligence and its RAG API keys are gone from the console, but a
// stage that ran them still holds their data: rows in UserInfoTable, the
// RagIndexerTable, and the S3 Vectors bucket of embeddings. Production keeps
// the table and the bucket when they leave sst.config.ts, because the app is
// `removal: 'retain'` there.

/** The S3 Vectors bucket sst.config.ts named for a stage while RAG shipped. */
export function ragVectorBucketName(stage: string): string {
  return `filone-${stage}-rag-vectors`;
}

/** The prefix SST gave the RagIndexerTable's physical name on a stage. */
export function ragIndexerTablePrefix(stage: string): string {
  return `filone-${stage}-RagIndexerTableTable`;
}

/**
 * Whether a UserInfoTable row belonged to RAG.
 *
 * Four shapes: a RAG key (`ORG#…` / `RAGKEY#…`), the lookup its token hash
 * resolves through (`RAGKEYHASH#…` / `LOOKUP`), the org's RAG config
 * (`ORG#…` / `RAGCONFIG`), and an early-access grant (`ALLOWLIST#…` / `RAG`).
 * The organizations beta shares the `ALLOWLIST#` partition under its own sort
 * key, so the sort key decides.
 */
export function isRagUserInfoRow(pk: string, sk: string): boolean {
  if (pk.startsWith('ORG#')) return sk.startsWith('RAGKEY#') || sk === 'RAGCONFIG';
  if (pk.startsWith('RAGKEYHASH#')) return sk === 'LOOKUP';
  if (pk.startsWith('ALLOWLIST#')) return sk === 'RAG';
  return false;
}
