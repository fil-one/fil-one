import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildContext, buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.ts';
import {
  getRequestDeadline,
  markRequestStep,
  requestDeadlineMiddleware,
  trackRequestStep,
} from './request-deadline.ts';

const USER_INFO = { userId: 'any-user', orgId: 'any-org' };

function runMiddleware(remainingMs: number) {
  return startRequest(remainingMs).event;
}

function startRequest(remainingMs: number) {
  // buildEvent attaches a default deadline for handler tests; drop it so the
  // only deadline on the event is the one the middleware attaches.
  const event = buildEvent({ userInfo: USER_INFO, requestContext: { deadline: undefined } });
  const request = buildMiddyRequest(event, {
    context: buildContext({ getRemainingTimeInMillis: () => remainingMs }),
  });
  const middleware = requestDeadlineMiddleware();
  middleware.before(request);
  return { event, request, middleware };
}

/** A request whose deadline the test fires by hand. */
function startRequestWithManualDeadline() {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { ...startRequest(10_000), deadline, consoleError };
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

  it('logs the step in flight when the deadline fires', () => {
    const { event, deadline, consoleError } = startRequestWithManualDeadline();
    markRequestStep(event, 'any-step');

    deadline.abort();

    expect(consoleError).toHaveBeenCalledWith('[request-deadline] Request deadline reached', {
      step: 'any-step',
      stepsInFlight: [],
      orgId: 'any-org',
      userId: 'any-user',
      apiRequestId: 'req-1',
    });
  });

  it('logs the deadline when it fires on a handler that marks no steps', () => {
    const { deadline, consoleError } = startRequestWithManualDeadline();

    deadline.abort();

    expect(consoleError).toHaveBeenCalledWith('[request-deadline] Request deadline reached', {
      stepsInFlight: [],
      orgId: 'any-org',
      userId: 'any-user',
      apiRequestId: 'req-1',
    });
  });

  it('names every tracked step still running when the deadline fires', async () => {
    const { event, deadline, consoleError } = startRequestWithManualDeadline();
    await trackRequestStep(event, 'any-settled-step', async () => {});
    void trackRequestStep(event, 'any-hung-step', () => new Promise(() => {}));
    void trackRequestStep(event, 'other-hung-step', () => new Promise(() => {}));

    deadline.abort();

    expect(consoleError).toHaveBeenCalledWith(
      '[request-deadline] Request deadline reached',
      expect.objectContaining({ stepsInFlight: ['any-hung-step', 'other-hung-step'] }),
    );
  });

  it('keeps a step in flight while another call of the same name is still running', async () => {
    const { event, deadline, consoleError } = startRequestWithManualDeadline();
    void trackRequestStep(event, 'any-step', () => new Promise(() => {}));
    await trackRequestStep(event, 'any-step', async () => {});

    deadline.abort();

    expect(consoleError).toHaveBeenCalledWith(
      '[request-deadline] Request deadline reached',
      expect.objectContaining({ stepsInFlight: ['any-step'] }),
    );
  });

  it.each([
    { outcome: 'resolved', run: async () => 'any-result' },
    { outcome: 'rejected', run: async () => Promise.reject(new Error('any-failure')) },
  ])('drops a tracked step from the log once it has $outcome', async ({ run }) => {
    const { event, deadline, consoleError } = startRequestWithManualDeadline();
    await trackRequestStep(event, 'any-step', run).catch(() => {});

    deadline.abort();

    expect(consoleError).toHaveBeenCalledWith(
      '[request-deadline] Request deadline reached',
      expect.objectContaining({ stepsInFlight: [] }),
    );
  });

  it.each(['after', 'onError'] as const)(
    'logs nothing when the deadline fires after the request ended in %s',
    (hook) => {
      const { event, request, middleware, deadline, consoleError } =
        startRequestWithManualDeadline();
      markRequestStep(event, 'any-step');

      middleware[hook](request);
      deadline.abort();

      expect(consoleError).not.toHaveBeenCalled();
    },
  );
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
