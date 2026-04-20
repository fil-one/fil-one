import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseListObjectsResponse,
  parseHeadObjectResponse,
  parseGetObjectRetentionResponse,
  parseS3ErrorResponse,
  executePresignedUrl,
} from './aurora-s3.js';

// ---------------------------------------------------------------------------
// parseListObjectsResponse
// ---------------------------------------------------------------------------

describe('parseListObjectsResponse', () => {
  it('parses a standard ListObjectsV2 response', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <IsTruncated>false</IsTruncated>
        <Contents>
          <Key>photo.jpg</Key>
          <Size>12345</Size>
          <LastModified>2026-01-15T10:30:00.000Z</LastModified>
          <ETag>"abc123"</ETag>
        </Contents>
        <Contents>
          <Key>doc.pdf</Key>
          <Size>67890</Size>
          <LastModified>2026-01-16T08:00:00.000Z</LastModified>
        </Contents>
      </ListBucketResult>`;

    const result = parseListObjectsResponse(xml);

    expect(result).toEqual({
      objects: [
        {
          key: 'photo.jpg',
          sizeBytes: 12345,
          lastModified: '2026-01-15T10:30:00.000Z',
          etag: '"abc123"',
        },
        {
          key: 'doc.pdf',
          sizeBytes: 67890,
          lastModified: '2026-01-16T08:00:00.000Z',
        },
      ],
      nextToken: undefined,
      isTruncated: false,
    });
  });

  it('parses an empty bucket', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`;

    const result = parseListObjectsResponse(xml);

    expect(result).toEqual({
      objects: [],
      nextToken: undefined,
      isTruncated: false,
    });
  });

  it('parses a truncated response with continuation token', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>token-abc</NextContinuationToken>
        <Contents>
          <Key>file1.txt</Key>
          <Size>100</Size>
          <LastModified>2026-02-01T00:00:00.000Z</LastModified>
        </Contents>
      </ListBucketResult>`;

    const result = parseListObjectsResponse(xml);

    expect(result).toEqual({
      objects: [
        {
          key: 'file1.txt',
          sizeBytes: 100,
          lastModified: '2026-02-01T00:00:00.000Z',
        },
      ],
      nextToken: 'token-abc',
      isTruncated: true,
    });
  });

  it('skips Contents entries without a Key', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <IsTruncated>false</IsTruncated>
        <Contents>
          <Size>100</Size>
        </Contents>
        <Contents>
          <Key>valid.txt</Key>
          <Size>200</Size>
          <LastModified>2026-01-01T00:00:00.000Z</LastModified>
        </Contents>
      </ListBucketResult>`;

    const result = parseListObjectsResponse(xml);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].key).toBe('valid.txt');
  });

  it('throws on malformed XML', () => {
    expect(() => parseListObjectsResponse('not xml at all <>')).toThrow(
      /Failed to parse S3 ListObjects response/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseHeadObjectResponse
// ---------------------------------------------------------------------------

describe('parseHeadObjectResponse', () => {
  function buildResponse(headers: Record<string, string>): Response {
    return new Response(null, { headers });
  }

  it('parses standard headers', () => {
    const response = buildResponse({
      'content-length': '1024',
      'last-modified': 'Wed, 15 Jan 2026 10:30:00 GMT',
      etag: '"abc123"',
      'content-type': 'application/pdf',
    });

    const result = parseHeadObjectResponse(response, 'doc.pdf');

    expect(result).toEqual({
      key: 'doc.pdf',
      sizeBytes: 1024,
      lastModified: new Date('Wed, 15 Jan 2026 10:30:00 GMT').toISOString(),
      etag: '"abc123"',
      contentType: 'application/pdf',
      metadata: {},
    });
  });

  it('extracts x-amz-meta-* headers as metadata', () => {
    const response = buildResponse({
      'content-length': '100',
      'last-modified': 'Wed, 15 Jan 2026 10:30:00 GMT',
      'x-amz-meta-filename': 'report.pdf',
      'x-amz-meta-description': 'Quarterly report',
      'x-amz-meta-tags': '["finance","q1"]',
    });

    const result = parseHeadObjectResponse(response, 'report.pdf');

    expect(result.metadata).toEqual({
      filename: 'report.pdf',
      description: 'Quarterly report',
      tags: '["finance","q1"]',
    });
  });

  it('extracts x-fil-cid header', () => {
    const response = buildResponse({
      'content-length': '100',
      'last-modified': 'Wed, 15 Jan 2026 10:30:00 GMT',
      'x-fil-cid': 'bafy2bzacedtest',
    });

    const result = parseHeadObjectResponse(response, 'file.bin');

    expect(result.filCid).toBe('bafy2bzacedtest');
  });

  it('omits optional fields when headers are absent', () => {
    const response = buildResponse({
      'content-length': '50',
      'last-modified': 'Wed, 15 Jan 2026 10:30:00 GMT',
    });

    const result = parseHeadObjectResponse(response, 'minimal.txt');

    expect(result.etag).toBeUndefined();
    expect(result.contentType).toBeUndefined();
    expect(result.filCid).toBeUndefined();
    expect(result.metadata).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseGetObjectRetentionResponse
// ---------------------------------------------------------------------------

describe('parseGetObjectRetentionResponse', () => {
  it('parses a GOVERNANCE retention response', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <Retention>
        <Mode>GOVERNANCE</Mode>
        <RetainUntilDate>2027-01-01T00:00:00.000Z</RetainUntilDate>
      </Retention>`;

    const result = parseGetObjectRetentionResponse(xml);

    expect(result).toEqual({
      mode: 'GOVERNANCE',
      retainUntilDate: '2027-01-01T00:00:00.000Z',
    });
  });

  it('parses a COMPLIANCE retention response', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <Retention>
        <Mode>COMPLIANCE</Mode>
        <RetainUntilDate>2028-06-15T12:00:00.000Z</RetainUntilDate>
      </Retention>`;

    const result = parseGetObjectRetentionResponse(xml);

    expect(result).toEqual({
      mode: 'COMPLIANCE',
      retainUntilDate: '2028-06-15T12:00:00.000Z',
    });
  });

  it('returns null when mode is missing', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <Retention>
        <RetainUntilDate>2027-01-01T00:00:00.000Z</RetainUntilDate>
      </Retention>`;

    expect(parseGetObjectRetentionResponse(xml)).toBeNull();
  });

  it('returns null when retainUntilDate is missing', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <Retention>
        <Mode>GOVERNANCE</Mode>
      </Retention>`;

    expect(parseGetObjectRetentionResponse(xml)).toBeNull();
  });

  it('returns null and logs error for malformed XML', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = parseGetObjectRetentionResponse('not xml <>');

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to parse S3 GetObjectRetention response:',
      expect.any(String),
    );

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// parseS3ErrorResponse
// ---------------------------------------------------------------------------

describe('parseS3ErrorResponse', () => {
  it('parses an S3 error XML', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <Error>
        <Code>NoSuchKey</Code>
        <Message>The specified key does not exist.</Message>
      </Error>`;

    const result = parseS3ErrorResponse(xml);

    expect(result).toEqual({
      code: 'NoSuchKey',
      message: 'The specified key does not exist.',
    });
  });

  it('returns defaults for missing fields', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Error></Error>`;

    const result = parseS3ErrorResponse(xml);

    expect(result).toEqual({
      code: 'UnknownError',
      message: 'An unknown S3 error occurred',
    });
  });
});

// ---------------------------------------------------------------------------
// executePresignedUrl
// ---------------------------------------------------------------------------

describe('executePresignedUrl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the response on success', async () => {
    const mockResponse = new Response('<xml>ok</xml>', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    const result = await executePresignedUrl('https://s3.example.com/obj?signed', 'GET');

    expect(result).toBe(mockResponse);
    expect(fetch).toHaveBeenCalledWith('https://s3.example.com/obj?signed', { method: 'GET' });
  });

  it('throws with S3 error details on non-2xx with XML body', async () => {
    const errorXml = `<?xml version="1.0" encoding="UTF-8"?>
      <Error>
        <Code>AccessDenied</Code>
        <Message>Access Denied</Message>
      </Error>`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(errorXml, { status: 403 }));

    await expect(executePresignedUrl('https://s3.example.com/obj?signed', 'GET')).rejects.toThrow(
      'S3 error: AccessDenied - Access Denied',
    );
  });

  it('throws with status code when response body is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    await expect(executePresignedUrl('https://s3.example.com/obj?signed', 'GET')).rejects.toThrow(
      'S3 request failed with status 500',
    );
  });
});
