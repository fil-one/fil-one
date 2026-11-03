/** An error with an HTTP status and a stable code, safe to return to the caller. */
export class EngineError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
    this.code = code;
  }
}

/** Error body every non-2xx engine response carries. */
export interface EngineErrorBody {
  error: { code: string; message: string; issues?: unknown };
}

/** Longest error message the engine returns to a caller. */
export const MAX_ERROR_MESSAGE = 200;

interface KnownCause {
  code: string;
  pattern: RegExp;
  message: string;
  /** The response for a request that fails with this cause, if not a 500. */
  http?: { status: number; code: string };
}

const KNOWN_CAUSES: KnownCause[] = [
  {
    code: 'CONDITIONAL_WRITE_REFUSED',
    pattern: /NotImplemented|conditional|If-None-Match|PreconditionFailed/i,
    message: 'The storage provider refused a conditional write, which every index commit needs',
  },
  {
    code: 'ACCESS_DENIED',
    pattern: /AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|\b403\b/,
    message: 'The storage provider denied access with the tenant key',
    http: { status: 403, code: 'S3_ACCESS_DENIED' },
  },
  {
    code: 'BUCKET_NOT_FOUND',
    pattern: /NoSuchBucket|no such bucket/i,
    message: 'The bucket does not exist',
    http: { status: 404, code: 'S3_BUCKET_NOT_FOUND' },
  },
];

/** The HTTP status and error name an AWS SDK error carries, if any. */
function sdkFields(error: unknown): { httpStatus?: number; name?: string } {
  const e = error as { $metadata?: { httpStatusCode?: number }; name?: string } | undefined;
  const httpStatus = e?.$metadata?.httpStatusCode;
  return {
    ...(typeof httpStatus === 'number' ? { httpStatus } : {}),
    ...(typeof e?.name === 'string' ? { name: e.name } : {}),
  };
}

/** The known cause an AWS SDK error's HTTP status implies, if any. */
function statusCause(error: unknown): string | undefined {
  const { httpStatus, name } = sdkFields(error);
  if (httpStatus === 403) return 'ACCESS_DENIED';
  // Only HeadBucket's bodiless 404; a GetObject 404 is a missing key.
  if (httpStatus === 404 && name === 'NotFound') return 'BUCKET_NOT_FOUND';
  return undefined;
}

function knownCause(error: unknown): KnownCause | undefined {
  const byStatus = KNOWN_CAUSES.find((cause) => cause.code === statusCause(error));
  if (byStatus) return byStatus;
  const raw = error instanceof Error ? error.message : String(error);
  return KNOWN_CAUSES.find((cause) => cause.pattern.test(raw));
}

/**
 * Text safe to show in a browser: the first line, without Rust source paths,
 * URL credentials or presigned query strings, capped at
 * {@link MAX_ERROR_MESSAGE} characters.
 */
export function safeMessage(text: string): string {
  const firstLine = (text.split('\n')[0] ?? '')
    // `, /Users/runner/.cargo/registry/.../file.rs:12:34` and similar.
    .replace(/,?\s*\S*\.cargo\/\S+/g, '')
    .replace(/\s+Caused by:.*$/, '')
    // `https://key:secret@host/...`
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1')
    // `https://host/key?X-Amz-Signature=...`
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, '$1')
    .trim();
  return firstLine.length > MAX_ERROR_MESSAGE
    ? `${firstLine.slice(0, MAX_ERROR_MESSAGE - 1)}…`
    : firstLine;
}

/**
 * A short, caller-safe description of an error: a stable code for the common
 * causes, `S3_HTTP_<status>` for other bodiless storage responses, otherwise
 * {@link safeMessage}. The full text belongs in the log only.
 */
export function summarizeError(error: unknown): string {
  if (error instanceof EngineError) return safeMessage(`${error.code}: ${error.message}`);
  const raw = error instanceof Error ? error.message : String(error);
  // A HEAD response has no body, so the SDK's message is just "UnknownError";
  // the status code is all there is to go on.
  const known = knownCause(error);
  if (known) return `${known.code}: ${known.message}`;
  const { httpStatus, name } = sdkFields(error);
  if (httpStatus !== undefined && (raw === 'UnknownError' || raw === '')) {
    return `S3_HTTP_${httpStatus}: The storage provider answered HTTP ${httpStatus}${
      name && name !== 'Unknown' && name !== 'UnknownError' ? ` (${name})` : ''
    }; check the endpoint and region`;
  }
  return safeMessage(raw);
}

/**
 * The response a failed request gets for a storage error with a known cause,
 * such as a wrong tenant key; undefined means a 500.
 */
export function storageErrorFor(error: unknown): EngineError | undefined {
  if (error instanceof EngineError) return undefined;
  const known = knownCause(error);
  return known?.http
    ? new EngineError(known.http.status, known.http.code, known.message)
    : undefined;
}

/** Fields for a log line about `error`: the full message, its name and HTTP status. */
export function errorLogFields(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...sdkFields(error),
  };
}
