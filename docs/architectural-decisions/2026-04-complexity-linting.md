# ADR: Complexity Linting with oxlint

**Status:** Accepted
**Date:** 2026-04-09

## Context

As coding agents take on more implementation work, we need guardrails to
prevent code quality from deteriorating over time. oxlint rules enforce file
size limits, function size limits, and cyclomatic/cognitive complexity limits,
catching growth before it becomes a problem.

## Decision

Enable `max-lines`, `max-lines-per-function`, and `complexity/complexity`
(from `oxlint-plugin-complexity`) in oxlint.

Choose thresholds to find the sweet spot where most of the current code
passes the check while the limits are not too lenient. We can lower the
thresholds later as the codebase improves.

### `max-lines` — 500 lines per file

Blank lines and comments are excluded so that developers are not penalized for
readable formatting or documentation.

### `max-lines-per-function` — tiered by package

Blank lines and comments are excluded.

- **Backend and shared packages**: 100 lines per function.
- **Website package**: 200 lines per function.

### `complexity/complexity` — cyclomatic 20, cognitive 15

Uses the defaults from `oxlint-plugin-complexity` (cyclomatic: 20, cognitive:
15).

- **Cyclomatic complexity**, introduced by Thomas McCabe in 1976, counts the
  number of linearly independent paths through a function. Each decision point
  (`if`, `for`, `case`, `&&`, `||`, etc.) adds one to the count. Higher values
  mean more paths to test and more room for defects.
- **Cognitive complexity**, introduced by G. Ann Campbell (SonarSource), measures
  how difficult code is to understand from a human perspective. Unlike cyclomatic
  complexity, it penalizes nesting depth — a deeply nested `if` costs more than a
  flat one. This better reflects the mental burden developers experience when
  reading code.

### Exemptions

**Test files (`*.test.ts`, `*.test.tsx`)** — all three rules are disabled. We
use `describe()` blocks to group tests into suites, and `max-lines-per-function`
counts all lines inside a `describe` block, including lines belonging to nested
`it` blocks. This makes the rule incompatible with our test style. Complexity
rules have similar issues with test setup and assertion patterns.

**`sst.config.ts`** — all three rules are disabled. Infrastructure-as-code can
be verbose, and extracting blocks of infra setup into functions does not always
improve readability — it can make the code harder to follow. Splitting
`sst.config.ts` into smaller files is viable but not the best use of our time
right now.

## Consequences

- Files exceeding 500 meaningful lines will fail the linter.
- Functions exceeding 100 lines (200 in the website package) will fail the
  linter.
- Functions exceeding cyclomatic complexity of 20 or cognitive complexity of 15
  will fail the linter.
- Coding agents and developers must keep new code within these limits or
  refactor existing code when modifying files that are close to the threshold.
- The thresholds can be tightened over time as existing violations are resolved.
