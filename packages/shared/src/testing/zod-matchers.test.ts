import { describe, it, expect } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';

const PersonSchema = z.object({
  name: z.string().min(2, 'Name is too short'),
  age: z.number(),
});

const shortName = { code: 'too_small', path: ['name'] };
const missingAge = { code: 'invalid_type', path: ['age'] };

describe('toMatchZodValidationError', () => {
  it('passes when the rejection has exactly the listed issues', () => {
    expect(PersonSchema.safeParse({ name: 'A' })).toMatchZodValidationError(shortName, missingAge);
  });

  it('accepts asymmetric matchers inside an issue', () => {
    expect(PersonSchema.safeParse({ name: 'A', age: 1 })).toMatchZodValidationError({
      path: ['name'],
      message: expect.stringContaining('too short'),
    });
  });

  it('fails and prints the data when the parse succeeded', () => {
    expect(() =>
      expect(PersonSchema.safeParse({ name: 'Alice', age: 30 })).toMatchZodValidationError(
        shortName,
      ),
    ).toThrow(/The parse succeeded with data:[\s\S]*"Alice"/);
  });

  it('fails when the rejection has an issue the test does not list', () => {
    expect(() =>
      expect(PersonSchema.safeParse({ name: 'A' })).toMatchZodValidationError(shortName),
    ).toThrow(/toMatchZodValidationError/);
  });

  it('fails when a listed issue is missing from the rejection', () => {
    expect(() =>
      expect(PersonSchema.safeParse({ name: 'A', age: 1 })).toMatchZodValidationError(
        shortName,
        missingAge,
      ),
    ).toThrow(/toMatchZodValidationError/);
  });

  it('fails when the issues come in a different order', () => {
    expect(() =>
      expect(PersonSchema.safeParse({ name: 'A' })).toMatchZodValidationError(
        missingAge,
        shortName,
      ),
    ).toThrow(/toMatchZodValidationError/);
  });

  it('shows only the fields the expected issue lists in the diff', () => {
    const message = getFailureMessage(() =>
      expect(PersonSchema.safeParse({ name: 'A', age: 1 })).toMatchZodValidationError({
        code: 'too_big',
      }),
    );
    expect(message).toContain(
      '  [\n    {\n-     "code": "too_big",\n+     "code": "too_small",\n    },\n  ]',
    );
  });

  it('throws when no expected issue is given', () => {
    expect(() =>
      // @ts-expect-error The matcher's type requires at least one issue.
      expect(PersonSchema.safeParse({ name: 'A' })).toMatchZodValidationError(),
    ).toThrow('toMatchZodValidationError() needs at least one expected issue.');
  });

  it('passes under .not when the issues differ', () => {
    expect(PersonSchema.safeParse({ name: 'A', age: 1 })).not.toMatchZodValidationError(missingAge);
  });
});

function getFailureMessage(assertion: () => void): string {
  try {
    assertion();
  } catch (error) {
    return stripVTControlCharacters(String(error));
  }
  throw new Error('Expected the assertion to fail');
}
