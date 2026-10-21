import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildContext, buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.ts';
import { getRequestDeadline, requestDeadlineMiddleware } from './request-deadline.ts';

const USER_INFO = { userId: 'any-user', orgId: 'any-org' };

function runMiddleware(remainingMs: number) {
  // buildEvent attaches a default deadline for handler tests; drop it so the
  // only deadline on the event is the one the middleware attaches.
  const event = buildEvent({ userInfo: USER_INFO, requestContext: { deadline: undefined } });
  const request = buildMiddyRequest(event, {
    context: buildContext({ getRemainingTimeInMillis: () => remainingMs }),
  });
  requestDeadlineMiddleware().before(request);
  return event;
}

describe('requestDeadlineMiddleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { remainingMs: 10_000, timeoutMs: 9_500, when: '500 ms before the Lambda timeout' },
    { remainingMs: 30_000, timeoutMs: 29_500, when: '500 ms before a longer Lambda timeout' },
    { remainingMs: 300, timeoutMs: 0, when: 'at once when less than the margin remains' },
  ])('sets the deadline to fire $when', ({ remainingMs, timeoutMs }) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    runMiddleware(remainingMs);

    expect(timeout).toHaveBeenCalledWith(timeoutMs);
  });

  it('attaches the deadline for getRequestDeadline to read', () => {
    const deadline = new AbortController().signal;
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline);

    const event = runMiddleware(10_000);

    expect(getRequestDeadline(event)).toBe(deadline);
  });
});

describe('getRequestDeadline', () => {
  it('throws when the handler chain has no requestDeadlineMiddleware', () => {
    // No middleware ran, so nothing attached a deadline.
    const event = buildEvent({ userInfo: USER_INFO, requestContext: { deadline: undefined } });

    expect(() => getRequestDeadline(event)).toThrow(
      new Error(
        'The request has no deadline: add requestDeadlineMiddleware() to the handler chain',
      ),
    );
  });
});
