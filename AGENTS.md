# Fil One

Monorepo for the Fil One product and its supporting packages.

## Console UI

For any UI work in `packages/website` (the console, the authenticated product; the directory name is legacy), follow [packages/website/DESIGN.md](packages/website/DESIGN.md) and the loader in [packages/website/CLAUDE.md](packages/website/CLAUDE.md).

## Code conventions

These apply in every package.

### Naming

These rules apply to new names; leave existing names alone.

- Start function names with a verb: `getDefaultBucketPolicy`, `isPrincipalCoveredByStatement`. Predicates use `is`, `has` or `can`. React components and hooks follow React conventions.
- Give sibling names one grammatical form. Permission groups are verbs (`read`, `write`, `protect`). Audit event types are `<subject>.<past-tense verb>` (`key.created`, `member.role_changed`). Result fields put the noun first (`keysRevoked`, `bucketsUpdated`).
- Name the exact meaning. `bucketsUpdated` counts successes where `bucketsReached` is vague; `boundToPrincipal` describes the key where `principalBound` reads as the principal. A new type name differs from existing types by more than a plural.

### Types

- Model mutually exclusive shapes as a union of interfaces (`ServiceAccessKey | PrincipalAccessKey`), each with only the fields valid for it.
- Let declared and inferred types flow. Add a cast only for a fact the compiler cannot know, with a comment naming that fact.
- Every package compiles for ES2022, the newest version the console's browsers support; the comment in `tsconfig.base.json` explains why. Use ES2022 built-ins such as `Object.hasOwn` and `Array.prototype.at` over hand-written equivalents.

### Comments

- When the code relies on a TypeScript choice that is not obvious (a type literal instead of an interface, a conditional or mapped type, an index signature), explain in a comment what the choice achieves, in plain words a reader without deep TypeScript knowledge follows.
- When code lists cases explicitly, such as the event types excluded from a union, describe in the comment the rule that selects them and let the code carry the list. A comment that repeats the list goes stale when someone adds a case.
- Re-read each comment against the code it describes before committing.

### Tests

- Assert on the whole result with `toMatchObject` or `toStrictEqual`, and on the specific error for a rejection. The failure message then shows what went wrong, and the test cannot pass for a different reason.

  ```ts
  // A failure prints only "expected true to be false"
  expect(schema.safeParse(input).success).toBe(false);

  // A failure prints the parser's error
  expect(schema.safeParse(input)).toMatchObject({
    success: false,
    error: { issues: [{ code: 'unrecognized_keys', keys: ['version'] }] },
  });
  ```

- Test one behavior per test. Write similar cases as `it.each` or a `for` loop with the case in the test name, and pass the input as the `expect` message inside any loop.
- Name each test by its behavior in plain words ("returns no effective actions for a principal the policy does not mention"), and check exactly what the name claims.
- Inline the data a test depends on, or name a shared fixture for what it grants (`grantReadToAlice`). Use ids that read as arbitrary (`any-user`). Comment the defect in each invalid input.
- Before finishing, break the behavior each new test names (flip a condition, swap an argument) and watch the test go red. A test that stays green verifies nothing.
