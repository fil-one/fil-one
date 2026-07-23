/**
 * Identifies the FTH request an error came from. `path` is the rendered
 * request path (client ref and all), so a logged error names the exact
 * resource — e.g. which client a 403 "out of scope" refers to — without the
 * caller having to re-attach that context.
 */
export interface FthRequestContext {
  method: string;
  path: string;
}

export class FthApiError extends Error {
  readonly status: number;
  readonly responseBody: unknown;
  readonly requestMethod?: string;
  readonly requestPath?: string;

  constructor(status: number, message: string, responseBody: unknown, request?: FthRequestContext) {
    const target = request ? ` [${request.method} ${request.path}]` : '';
    super(`FTH API request failed (${status})${target}: ${message}`);
    this.name = 'FthApiError';
    this.status = status;
    this.responseBody = responseBody;
    this.requestMethod = request?.method;
    this.requestPath = request?.path;
  }
}

export class FthUnauthorizedError extends FthApiError {
  constructor(message: string, responseBody: unknown, request?: FthRequestContext) {
    super(401, message, responseBody, request);
    this.name = 'FthUnauthorizedError';
  }
}

export class FthNotFoundError extends FthApiError {
  constructor(message: string, responseBody: unknown, request?: FthRequestContext) {
    super(404, message, responseBody, request);
    this.name = 'FthNotFoundError';
  }
}

export class FthConflictError extends FthApiError {
  constructor(message: string, responseBody: unknown, request?: FthRequestContext) {
    super(409, message, responseBody, request);
    this.name = 'FthConflictError';
  }
}

export function createApiError(
  status: number,
  message: string,
  responseBody: unknown,
  request?: FthRequestContext,
): FthApiError {
  switch (status) {
    case 401:
      return new FthUnauthorizedError(message, responseBody, request);
    case 404:
      return new FthNotFoundError(message, responseBody, request);
    case 409:
      return new FthConflictError(message, responseBody, request);
    default:
      return new FthApiError(status, message, responseBody, request);
  }
}
