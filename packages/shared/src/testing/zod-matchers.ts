import { expect } from 'vitest';
import type { z } from 'zod';

/**
 * Some fields of one zod issue, matched like `toMatchObject`: list the fields
 * that identify the rejection, such as `code`, `path` and `message`. A field
 * can hold an asymmetric matcher such as `expect.stringContaining()`.
 */
export type ExpectedZodIssue = PartialIssue<z.core.$ZodIssue>;

// Applies Partial to each issue kind separately, so `code` decides which
// other fields are allowed.
type PartialIssue<Issue> = Issue extends unknown ? Partial<Issue> : never;

declare module 'vitest' {
  // The type parameter must match vitest's own declaration for the merge to work.
  // oxlint-disable-next-line typescript/no-explicit-any
  interface Matchers<T = any> {
    /**
     * Checks that a `safeParse()` result is a rejection with exactly these
     * issues, in this order.
     *
     * @example
     * expect(schema.safeParse(input)).toMatchZodValidationError({
     *   code: 'invalid_type',
     *   path: ['name'],
     * });
     */
    toMatchZodValidationError: (...issues: [ExpectedZodIssue, ...ExpectedZodIssue[]]) => T;
  }
}

expect.extend({
  toMatchZodValidationError(received: unknown, ...issues: ExpectedZodIssue[]) {
    if (issues.length === 0) {
      throw new Error('toMatchZodValidationError() needs at least one expected issue.');
    }

    const expected = { success: false, error: { issues } };
    const pass = this.equals(received, expected, [
      ...this.customTesters,
      this.utils.iterableEquality,
      this.utils.subsetEquality,
    ]);
    const hint = this.utils.matcherHint('toMatchZodValidationError', undefined, 'issues', {
      isNot: this.isNot,
    });

    if (isSuccessfulParse(received)) {
      return {
        pass,
        message: () =>
          `${hint}\n\nThe parse succeeded with data:\n` + this.utils.printReceived(received.data),
      };
    }

    const receivedIssues = getIssues(received);
    return {
      pass,
      message: () =>
        pass
          ? `${hint}\n\nThe parse failed with the issues it should not have:\n` +
            this.utils.printReceived(receivedIssues)
          : `${hint}\n\n` + this.utils.diff(issues, receivedIssues),
    };
  },
});

function isSuccessfulParse(received: unknown): received is { success: true; data: unknown } {
  return (
    typeof received === 'object' &&
    received !== null &&
    'success' in received &&
    received.success === true
  );
}

function getIssues(received: unknown): unknown {
  if (typeof received !== 'object' || received === null || !('error' in received)) return received;
  const { error } = received;
  if (typeof error !== 'object' || error === null || !('issues' in error)) return received;
  return error.issues;
}
