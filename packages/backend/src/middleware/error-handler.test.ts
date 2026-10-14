import { describe, it, expect, vi } from 'vitest';
import type { Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { ApiErrorCode, S3Region } from '@filone/shared';
import { errorHandlerMiddleware } from './error-handler.ts';
import { OrgDeletingError } from '../lib/org-profile.ts';
import { IamRegionRefusedError } from '../lib/errors.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';

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

  // Mapped centrally so no writer has to catch it, and so it can never be
  // reported as a 500 the caller would retry.
  it('maps OrgDeletingError to 410 ACCOUNT_DELETED', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { onError } = errorHandlerMiddleware();
    const request = buildErrorRequest(new OrgDeletingError('org-1'));

    try {
      await onError!(request);
    } finally {
      warn.mockRestore();
    }

    expect(request.response).toMatchObject({
      statusCode: 410,
      body: JSON.stringify({
        message: 'This account has been deleted.',
        code: ApiErrorCode.ACCOUNT_DELETED,
      }),
    });
  });

  it.each([
    {
      action: 'remove' as const,
      message: `The member could not be removed from ${S3Region.UsEast9}, so they are still in this organization. Try again.`,
    },
    {
      action: 'register' as const,
      message: `The invitation could not be accepted on ${S3Region.UsEast9}. Try again.`,
    },
  ])(
    'maps IamRegionRefusedError on $action to 502 naming the region',
    async ({ action, message }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { onError } = errorHandlerMiddleware();
      const request = buildErrorRequest(new IamRegionRefusedError(action, [S3Region.UsEast9]));

      try {
        await onError!(request);
      } finally {
        warn.mockRestore();
      }

      expect(request.response).toMatchObject({
        statusCode: 502,
        body: JSON.stringify({ message }),
      });
    },
  );

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
