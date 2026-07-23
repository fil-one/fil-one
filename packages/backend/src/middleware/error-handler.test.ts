import { describe, it, expect, vi } from 'vitest';
import type { Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { errorHandlerMiddleware } from './error-handler.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

type ErrorRequest = Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>;

function buildErrorRequest(error: Error): ErrorRequest {
  return {
    event: buildEvent(),
    context: {} as Context,
    response: undefined,
    error,
    internal: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('errorHandlerMiddleware', () => {
  it('sets a 500 response with a generic error message', async () => {
    const { onError } = errorHandlerMiddleware();
    const request = buildErrorRequest(new Error('db connection failed'));

    await onError!(request);

    expect(request.response).toMatchObject({
      statusCode: 500,
      body: JSON.stringify({
        message: 'An unexpected server error occurred. Please try again later.',
      }),
    });
  });

  it('does not expose the original error message in the response', async () => {
    const { onError } = errorHandlerMiddleware();
    const secret = 'password=hunter2&host=prod-db.internal';
    const request = buildErrorRequest(new Error(secret));

    await onError!(request);

    const body = (request.response as { body: string }).body;
    expect(body).not.toContain(secret);
    expect(body).not.toContain('hunter2');
  });

  it('logs the full error with user context from an authenticated event', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { onError } = errorHandlerMiddleware();
    const error = new Error('something broke');
    const request = buildErrorRequest(error);
    request.event = buildEvent({
      userInfo: { userId: 'user-1', orgId: 'org-1' },
    });

    await onError!(request);

    expect(spy).toHaveBeenCalledWith(
      'Unhandled handler error:',
      { orgId: 'org-1', userId: 'user-1', apiRequestId: 'req-1' },
      error,
    );
    spy.mockRestore();
  });

  it('logs undefined user context when the event is not authenticated', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { onError } = errorHandlerMiddleware();
    const error = new Error('something broke');
    const request = buildErrorRequest(error);

    await onError!(request);

    expect(spy).toHaveBeenCalledWith(
      'Unhandled handler error:',
      { orgId: undefined, userId: undefined, apiRequestId: 'req-1' },
      error,
    );
    spy.mockRestore();
  });

  it('includes security headers in the response', async () => {
    const { onError } = errorHandlerMiddleware();
    const request = buildErrorRequest(new Error('fail'));

    await onError!(request);

    const headers = (request.response as { headers: Record<string, string> }).headers;
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('overwrites any existing response', async () => {
    const { onError } = errorHandlerMiddleware();
    const request = buildErrorRequest(new Error('fail'));
    request.response = { statusCode: 200, body: '{"ok":true}' };

    await onError!(request);

    expect((request.response as { statusCode: number }).statusCode).toBe(500);
  });
});
