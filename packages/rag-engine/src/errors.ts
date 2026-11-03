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
export const MAX_ERROR_MESSAGE = 300;

const KNOWN_CAUSES: { code: string; pattern: RegExp; message: string }[] = [
  {
    code: 'CONDITIONAL_WRITE_REFUSED',
    pattern: /NotImplemented|conditional|If-None-Match|PreconditionFailed/i,
    message: 'The storage provider refused a conditional write, which every index commit needs',
  },
  {
    code: 'ACCESS_DENIED',
    pattern: /AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|\b403\b/,
    message: 'The storage provider denied access with the tenant key',
  },
  {
    code: 'BUCKET_NOT_FOUND',
    pattern: /NoSuchBucket|no such bucket/i,
    message: 'The bucket does not exist',
  },
];

/**
 * A short, caller-safe description of an error: a stable code for the common
 * causes, otherwise the first line with Rust source paths removed, capped at
 * {@link MAX_ERROR_MESSAGE} characters. The full text belongs in the log only.
 */
export function summarizeError(error: unknown): string {
  if (error instanceof EngineError) return `${error.code}: ${error.message}`;
  const raw = error instanceof Error ? error.message : String(error);
  const known = KNOWN_CAUSES.find((cause) => cause.pattern.test(raw));
  if (known) return `${known.code}: ${known.message}`;
  const firstLine = (raw.split('\n')[0] ?? '')
    // `, /Users/runner/.cargo/registry/.../file.rs:12:34` and similar.
    .replace(/,?\s*\/\S*\.cargo\/\S+/g, '')
    .replace(/\s+Caused by:.*$/, '')
    .trim();
  return firstLine.length > MAX_ERROR_MESSAGE
    ? `${firstLine.slice(0, MAX_ERROR_MESSAGE - 1)}…`
    : firstLine;
}
