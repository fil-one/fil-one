# Fil One

Monorepo for the Fil One product and its supporting packages.

## Console UI

For any UI work in `packages/website` (the console, the authenticated product; the directory name is legacy), follow [packages/website/DESIGN.md](packages/website/DESIGN.md) and the loader in [packages/website/CLAUDE.md](packages/website/CLAUDE.md).

## Code conventions

### Naming

These rules apply to new names; leave existing names alone. In React code, React's naming conventions for components and hooks take precedence over these rules.

- Start function names with a verb: `getDefaultBucketPolicy`, `isPrincipalCoveredByStatement`. Predicates use `is`, `has` or `can`.
- Give sibling names one grammatical form. Permission groups are verbs (`read`, `write`, `protect`). Audit event types are `<subject>.<past-tense verb>` (`key.created`, `member.role_changed`). Result fields put the noun first (`keysRevoked`, `bucketsUpdated`).
- Name the exact meaning. `bucketsUpdated` counts successes where `bucketsReached` is vague; `boundToPrincipal` describes the key where `principalBound` reads as the principal.
- Reserve the plural of a type name for a collection of that type. `AccessKeyPermissions` reads as `AccessKeyPermission[]`, so an object holding `{ permissions, granularPermissions }` needs a name of its own.

### Types

- Model mutually exclusive shapes as a union of interfaces (`ServiceAccessKey | PrincipalAccessKey`), each with only the fields valid for it.
- When a type does not fit the code using it, fix the type definition so that code compiles without a cast. Cast only for a fact the compiler cannot know, with a comment naming that fact.
- Every package compiles for ES2022 (`tsconfig.base.json` explains why). Use ES2022 built-ins such as `Object.hasOwn` and `Array.prototype.at` over hand-written equivalents.

### Comments

- When the code relies on a TypeScript choice that is not obvious (a type literal instead of an interface, a conditional or mapped type, an index signature), explain in a comment what the choice achieves, in plain words a reader without deep TypeScript knowledge follows.
- When code lists cases explicitly, such as the event types excluded from a union, describe in the comment the rule that selects them and let the code carry the list. A comment that repeats the list goes stale when someone adds a case.
- Re-read each comment against the code it describes before committing.

### Tests

- Assert on the result object with `toMatchObject` or `toStrictEqual`, and on the specific error for a rejection. The failure message then shows what went wrong, and the test cannot pass for a different reason. Assert on a single property only when its value alone explains a failure.

  ```ts
  // Bad: a failure prints only "expected true to be false"
  expect(schema.safeParse(input).success).toBe(false);

  // Good: a failure prints the parser's error
  expect(schema.safeParse(input)).toMatchObject({
    success: false,
    error: { issues: [{ code: 'unrecognized_keys', keys: ['version'] }] },
  });
  ```

- Test one behavior per test. Write similar cases as `it.each` with the case in the test name. When `it.each` does not fit and a test repeats an assertion in a loop, pass the case to `expect` as its message, so a failure names the case that failed.
- Name each test by its behavior in plain words: the expected outcome first, then the condition under which it happens ("returns no effective actions for a principal the policy does not mention"). Make the test assert exactly what its name describes.
- Make each test show which properties of its input matter to the behavior it checks, and leave out the ones that don't. Choose the form that fits:
  - A test-data builder: the test sets only the relevant fields and the builder fills in defaults for the rest.
  - A shared fixture whose name tells the reader the scenario (`grantReadToAlice`).
  - The input written inline, when it is short.
- Use ids that read as arbitrary (`any-user`); an id that sounds meaningful (`admin-user`) suggests the test depends on it. In each invalid input, comment what makes it invalid.
- Before finishing, break the behavior each new test names (flip a condition, swap an argument) and watch the test go red. A test that stays green verifies nothing.
