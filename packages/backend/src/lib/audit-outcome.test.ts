import { describe, expect, it } from 'vitest';

import { isOutcomeUnknown } from './audit-outcome.ts';

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

function named(name: string, cause?: unknown): Error {
  return Object.assign(new Error(`any ${name}`, { cause }), { name });
}

describe('isOutcomeUnknown', () => {
  it.each([
    ['the request deadline fired', new Error('any error'), abortedSignal()],
    ['the call timed out', named('TimeoutError'), undefined],
    ['the call was aborted', named('AbortError'), undefined],
    [
      'a wrapped error was caused by a timeout',
      new Error('any wrapper', { cause: named('TimeoutError') }),
      undefined,
    ],
  ])('calls the outcome unknown when %s', (_case, error, deadline) => {
    expect(isOutcomeUnknown(error, deadline)).toBe(true);
  });

  it.each([
    ['the storage system refused the call', new Error('any refusal'), new AbortController().signal],
    ['there is no deadline and no timeout', new Error('any refusal'), undefined],
  ])('calls the outcome known when %s', (_case, error, deadline) => {
    expect(isOutcomeUnknown(error, deadline)).toBe(false);
  });
});
