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
