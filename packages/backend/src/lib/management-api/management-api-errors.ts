// Error taxonomy for the generic Service Orchestrator Management API
// (docs/service-orchestrator-integration/management-openapi.yaml). Mirrors
// fth-api-errors.ts, plus a validation subclass because the contract
// distinguishes malformed requests (400) from semantic body failures (422).

export class ManagementApiError extends Error {
  readonly status: number;
  readonly responseBody: unknown;

  constructor(status: number, message: string, responseBody: unknown, options?: ErrorOptions) {
    super(`Management API request failed (${status}): ${message}`, options);
    this.name = 'ManagementApiError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class ManagementApiUnauthorizedError extends ManagementApiError {
  constructor(message: string, responseBody: unknown) {
    super(401, message, responseBody);
    this.name = 'ManagementApiUnauthorizedError';
  }
}

export class ManagementApiNotFoundError extends ManagementApiError {
  constructor(message: string, responseBody: unknown) {
    super(404, message, responseBody);
    this.name = 'ManagementApiNotFoundError';
  }
}

export class ManagementApiConflictError extends ManagementApiError {
  constructor(message: string, responseBody: unknown) {
    super(409, message, responseBody);
    this.name = 'ManagementApiConflictError';
  }
}

// The contract returns 400 for malformed requests (bad query/path params,
// unparseable JSON) and 422 for well-formed bodies that fail semantic
// validation. Callers treat both as "the request itself is wrong".
export class ManagementApiValidationError extends ManagementApiError {
  constructor(status: 400 | 422, message: string, responseBody: unknown) {
    super(status, message, responseBody);
    this.name = 'ManagementApiValidationError';
  }
}

export function createApiError(
  status: number,
  message: string,
  responseBody: unknown,
): ManagementApiError {
  switch (status) {
    case 400:
    case 422:
      return new ManagementApiValidationError(status, message, responseBody);
    case 401:
      return new ManagementApiUnauthorizedError(message, responseBody);
    case 404:
      return new ManagementApiNotFoundError(message, responseBody);
    case 409:
      return new ManagementApiConflictError(message, responseBody);
    default:
      return new ManagementApiError(status, message, responseBody);
  }
}
