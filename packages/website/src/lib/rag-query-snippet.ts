import { API_URL } from '../env.js';

/**
 * A curl call for `POST /api/buckets/{name}/query`, shared by the per-bucket
 * drawer (which passes a real bucket, giving a runnable command) and the API tab
 * (which passes placeholders, giving the endpoint shape). One builder so the
 * request shape cannot drift between the two places it is shown.
 *
 * `$FILONE_RAG_KEY` is an env var rather than a literal token, so copy-paste-edit
 * does not leave a real key in shell history.
 */
export function buildQueryCurl({
  bucketName,
  region,
}: {
  bucketName: string;
  region: string;
}): string {
  // Full URL so the sample runs outside the browser. In prod API_URL is empty
  // (same-origin behind CloudFront), so fall back to the page's own origin.
  // Read at call time so jsdom tests get a value.
  const baseUrl = API_URL || window.location.origin;
  return [
    `curl -X POST "${baseUrl}/api/buckets/${bucketName}/query?region=${region}" \\`,
    `  -H "Authorization: Bearer $FILONE_RAG_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify({ query: 'What are the retention policies?', top_k: 5 })}'`,
  ].join('\n');
}
