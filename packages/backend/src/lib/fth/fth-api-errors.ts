export class FthApiError extends Error {
  readonly status: number;
  readonly responseBody: unknown;

  constructor(status: number, message: string, responseBody: unknown, options?: ErrorOptions) {
    super(`FTH API request failed (${status}): ${message}`, options);
    this.name = 'FthApiError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class FthUnauthorizedError extends FthApiError {
  constructor(message: string, responseBody: unknown) {
    super(401, message, responseBody);
    this.name = 'FthUnauthorizedError';
  }
}

export class FthNotFoundError extends FthApiError {
  constructor(message: string, responseBody: unknown) {
    super(404, message, responseBody);
    this.name = 'FthNotFoundError';
  }
}

export class FthConflictError extends FthApiError {
  constructor(message: string, responseBody: unknown) {
    super(409, message, responseBody);
    this.name = 'FthConflictError';
  }
}

export function createApiError(
  status: number,
  message: string,
  responseBody: unknown,
): FthApiError {
  switch (status) {
    case 401:
      return new FthUnauthorizedError(message, responseBody);
    case 404:
      return new FthNotFoundError(message, responseBody);
    case 409:
      return new FthConflictError(message, responseBody);
    default:
      return new FthApiError(status, message, responseBody);
  }
}
