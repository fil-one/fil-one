import type { ListObjectsResponse, S3Object, ObjectRetentionInfo } from '@filone/shared';

// ── S3 XML Response Parsers ────────────────────────────────────────

function getText(parent: Element, tag: string): string | undefined {
  return parent.getElementsByTagName(tag)[0]?.textContent ?? undefined;
}

/**
 * Parse an S3 ListObjectsV2 XML response into our ListObjectsResponse shape.
 */
export function parseListObjectsResponse(xml: string): ListObjectsResponse {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  const errorNode = doc.querySelector('parsererror');
  if (errorNode) {
    throw new Error(
      `Failed to parse S3 ListObjects response: ${errorNode.textContent ?? 'unknown parse error'}`,
    );
  }

  const contents = doc.getElementsByTagName('Contents');
  const objects: S3Object[] = [];

  for (let i = 0; i < contents.length; i++) {
    const el = contents[i];
    const key = getText(el, 'Key');
    if (!key) continue;

    objects.push({
      key,
      sizeBytes: parseInt(getText(el, 'Size') ?? '0', 10),
      lastModified: getText(el, 'LastModified') ?? new Date().toISOString(),
      ...(getText(el, 'ETag') && { etag: getText(el, 'ETag') }),
    });
  }

  const nextToken = getText(doc.documentElement, 'NextContinuationToken');
  const isTruncated = getText(doc.documentElement, 'IsTruncated') === 'true';

  return { objects, nextToken, isTruncated };
}

/**
 * Parse an S3 HeadObject response (HTTP headers only) into metadata.
 */
export function parseHeadObjectResponse(
  response: Response,
  key: string,
): {
  key: string;
  sizeBytes: number;
  lastModified: string;
  etag?: string;
  contentType?: string;
  metadata: Record<string, string>;
  filCid?: string;
} {
  const headers = response.headers;

  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith('x-amz-meta-')) {
      metadata[name.slice('x-amz-meta-'.length)] = value;
    }
  });

  const etag = headers.get('etag') ?? undefined;
  const contentType = headers.get('content-type') ?? undefined;
  const filCid = headers.get('x-fil-cid') ?? undefined;

  return {
    key,
    sizeBytes: parseInt(headers.get('content-length') ?? '0', 10),
    lastModified: headers.get('last-modified')
      ? new Date(headers.get('last-modified')!).toISOString()
      : new Date().toISOString(),
    ...(etag && { etag }),
    ...(contentType && { contentType }),
    metadata,
    ...(filCid && { filCid }),
  };
}

/**
 * Parse an S3 GetObjectRetention XML response.
 * Returns null if the response indicates no retention (e.g., 404 or empty).
 */
export function parseGetObjectRetentionResponse(xml: string): ObjectRetentionInfo | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  const errorNode = doc.querySelector('parsererror');
  if (errorNode) {
    console.error(
      'Failed to parse S3 GetObjectRetention response:',
      errorNode.textContent ?? 'unknown parse error',
    );
    return null;
  }

  const mode = getText(doc.documentElement, 'Mode');
  const retainUntilDate = getText(doc.documentElement, 'RetainUntilDate');

  if (!mode || !retainUntilDate) return null;

  return {
    mode: mode as 'GOVERNANCE' | 'COMPLIANCE',
    retainUntilDate,
  };
}

/**
 * Parse an S3 error XML response.
 */
export function parseS3ErrorResponse(xml: string): { code: string; message: string } {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const code = getText(doc.documentElement, 'Code') ?? 'UnknownError';
  const message = getText(doc.documentElement, 'Message') ?? 'An unknown S3 error occurred';
  return { code, message };
}

/**
 * Execute a presigned URL and handle S3-level errors.
 * Throws an Error with the S3 error message on non-2xx responses.
 */
export async function executePresignedUrl(url: string, method: string): Promise<Response> {
  const response = await fetch(url, { method });

  if (!response.ok) {
    const body = await response.text();
    if (body) {
      const s3Error = parseS3ErrorResponse(body);
      throw new Error(`S3 error: ${s3Error.code} - ${s3Error.message}`);
    }
    throw new Error(`S3 request failed with status ${response.status}`);
  }

  return response;
}
