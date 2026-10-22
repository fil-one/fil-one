import { describe, it, expect, vi } from 'vitest';
import type { Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { ApiErrorCode, S3Region } from '@filone/shared';
import { errorHandlerMiddleware } from './error-handler.ts';
import { OrgDeletingError } from '../lib/org-profile.ts';
import { IamRegionRefusedError } from '../lib/errors.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';

const USER_1 = '00000000-0000-0000-0000-000000000001';

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

  it.each([
    // What fetch rejects with.
    { condition: 'is the deadline abort', wrap: (abort: Error) => abort },
    // What the AWS SDK rejects with, then wrapped once more by the orchestrator.
    {
      condition: 'wraps the deadline abort as its cause',
      wrap: (abort: Error) =>
        new Error('Failed to fetch bucket', {
          cause: Object.assign(new Error('Request aborted', { cause: abort }), {
            name: 'AbortError',
          }),
        }),
    },
  ])('sets a 504 response when the error $condition', async ({ wrap }) => {
    const deadline = AbortSignal.abort(new DOMException('deadline', 'TimeoutError'));
    const { onError } = errorHandlerMiddleware();
    const request = buildErrorRequest(wrap(deadline.reason));
    request.event = buildEvent({ requestContext: { deadline } });

    await onError!(request);

    expect(request.response).toMatchObject({
      statusCode: 504,
      body: JSON.stringify({
        message: 'The storage service took too long to respond. Please try again.',
      }),
    });
  });

  it.each([
    // A handler settled the aborted call itself, then failed for another reason.
    {
      condition: 'has fired but did not cause the error',
      deadline: AbortSignal.abort(new DOMException('deadline', 'TimeoutError')),
    },
    { condition: 'has not fired', deadline: new AbortController().signal },
    { condition: 'is not attached', deadline: undefined },
  ])('sets a 500 response when the request deadline $condition', async ({ deadline }) => {
    const { onError } = errorHandlerMiddleware();
    const request = buildErrorRequest(new Error('any-failure'));
    request.event = buildEvent({ requestContext: { deadline } });

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
      succeeded: [],
      message: 'We could not remove the member from this organization. Please try again.',
    },
    {
      action: 'remove' as const,
      succeeded: [S3Region.EuCentral3],
      message: `The member was removed from ${S3Region.EuCentral3} but could not be removed from ${S3Region.UsEast9}. They are still in this organization, please try again.`,
    },
    {
      action: 'register' as const,
      succeeded: [],
      message:
        'The member joined, but could not be registered on the storage regions. Please try again.',
    },
    {
      action: 'register' as const,
      succeeded: [S3Region.EuCentral3],
      message: `The member joined, and was registered on ${S3Region.EuCentral3} but not on ${S3Region.UsEast9}. Please try again.`,
    },
  ])(
    'maps IamRegionRefusedError on $action to 502 that says which regions applied it',
    async ({ action, succeeded, message }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { onError } = errorHandlerMiddleware();
      const request = buildErrorRequest(
        new IamRegionRefusedError(action, [S3Region.UsEast9], succeeded),
      );

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
      userInfo: { userId: USER_1, orgId: 'org-1' },
    });

    await onError!(request);

    expect(spy).toHaveBeenCalledWith(
      'Unhandled handler error:',
      { orgId: 'org-1', userId: USER_1, apiRequestId: 'req-1' },
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
