# ADR: Complexity Linting with oxlint

**Status:** Accepted
**Date:** 2026-04-09

## Context

As coding agents take on more implementation work, we need guardrails to
prevent code quality from deteriorating over time. Two oxlint rules —
`max-lines` and `max-lines-per-function` — provide automated enforcement of
file and function size limits, catching growth before it becomes a problem.

## Decision

Enable `max-lines` and `max-lines-per-function` in oxlint. Both rules count
only meaningful code lines — blank lines and comments are excluded so that
developers are not penalized for readable formatting or documentation.

### `max-lines` — 500 lines per file

### `max-lines-per-function` — tiered by package

- **Backend and shared packages**: 100 lines per function.
- **Website package**: 200 lines per function.

These initial thresholds were chosen to find the sweet spot where most of the
current code passes the check while the limits are not too lenient. We can lower
the thresholds later as the codebase improves.

### Exemptions

**Test files (`*.test.ts`, `*.test.tsx`)** — both rules are disabled. We use
`describe()` blocks to group tests into suites, and `max-lines-per-function`
counts all lines inside a `describe` block, including lines belonging to nested
`it` blocks. This makes the rule incompatible with our test style.

**`sst.config.ts`** — both rules are disabled. Infrastructure-as-code can be
verbose, and extracting blocks of infra setup into functions does not always
improve readability — it can make the code harder to follow. Splitting
`sst.config.ts` into smaller files is viable but not the best use of our time
right now.

## Consequences

- Files exceeding 500 meaningful lines will fail the linter.
- Functions exceeding 100 lines (200 in the website package) will fail the
  linter.
- Coding agents and developers must keep new code within these limits or
  refactor existing code when modifying files that are close to the threshold.
- The thresholds can be tightened over time as existing violations are resolved.
