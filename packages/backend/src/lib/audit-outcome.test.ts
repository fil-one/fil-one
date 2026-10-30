import { describe, expect, it } from 'vitest';

import { isOutcomeUnknown } from './audit-outcome.ts';

/** A deadline that has fired, with the reason it fired for. */
function firedDeadline(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error('any deadline'));
  return controller.signal;
}

function named(name: string): Error {
  return Object.assign(new Error(`any ${name}`), { name });
}

/** A Node system error, as a socket failure arrives. */
function systemError(code: string): Error {
  return Object.assign(new Error(`any ${code}`), { code });
}

describe('isOutcomeUnknown', () => {
  it('calls the outcome unknown when the request deadline cut the call off', () => {
    const deadline = firedDeadline();

    expect(isOutcomeUnknown(new Error('any wrapper', { cause: deadline.reason }), deadline)).toBe(
      true,
    );
  });

  it.each([
    ['the call timed out', named('TimeoutError')],
    ['the call was aborted', named('AbortError')],
    ['the connection was reset after sending', systemError('ECONNRESET')],
    [
      'a wrapped error was caused by a timeout',
      new Error('any wrapper', { cause: named('TimeoutError') }),
    ],
  ])('calls the outcome unknown when %s', (_case, error) => {
    expect(isOutcomeUnknown(error)).toBe(true);
  });

  it.each([
    ['the storage system refused the call', new Error('any refusal'), new AbortController().signal],
    ['there is no deadline and no timeout', new Error('any refusal'), undefined],
    // The deadline fired, but this error is not the deadline's doing.
    ['a refusal arrives after the deadline fired', new Error('any refusal'), firedDeadline()],
    // A refused connection never sent the request.
    ['the connection was refused', systemError('ECONNREFUSED'), undefined],
  ])('calls the outcome known when %s', (_case, error, deadline) => {
    expect(isOutcomeUnknown(error, deadline)).toBe(false);
  });
});
