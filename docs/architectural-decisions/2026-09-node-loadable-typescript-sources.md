# ADR: Node-loadable TypeScript sources

**Status:** Proposed
**Date:** 2026-09-08

## Context

The operator scripts in `bin/` run as `node bin/<script>.ts`, with Node's
built-in type stripping and no bundler. Node strips type annotations and
nothing else. It does not rewrite import specifiers and it does not compile
enums. The backend and `@filone/shared` are written for esbuild and vitest,
which do both. As a result a `bin/` script cannot import a backend module, and
the scripts carry copies of the constants and key builders they need instead.

Nine scripts and helpers under `bin/` hold such copies today: the BillingTable
and OrgTable key builders, the deletion-record status values, the sweeper's
blocked-attempts threshold, the orgs-beta row keys, the FTH console key name,
and the RAG index key shapes. Each copy carries a "keep in sync" comment. Two
of them are held to the original by a vitest test that imports the backend
module, which vitest can resolve where Node cannot. The rest are held by hand.
A key format that changes in the backend and not in the script corrupts or
misses rows on the next production run, and nothing warns.

Three things stop the import, measured against the working tree on
2026-09-08:

| Blocker                                  | Where                                                                                                 | Effect under Node                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Relative specifiers ending in `.js`      | 1602 lines in backend, shared and rag-shared, of which 179 are `vi.mock` calls and 33 dynamic imports | `Cannot find module './x.js'`                         |
| TypeScript `enum`                        | 8 in `@filone/shared`, 2 in backend                                                                   | `TypeScript enum is not supported in strip-only mode` |
| Type-only imports written without `type` | 10 sites, one of them a bare import from `aws-lambda`, which has no runtime package                   | the import survives stripping and fails to resolve    |

A module with none of these loads today:
`packages/backend/src/lib/deletion-record.ts` imports cleanly under plain
`node`. The specifier rewrite alone lets
`subscription-store.ts`, `orgs-beta.ts` and the FTH tenant setup load. Adding
the enum conversion lets `@filone/shared` load.

One constraint survives every fix. `Resource` from `sst` imports fine and
throws on the first property access outside `sst shell`, and `bin/` scripts
run outside it by design. Most backend modules read it inside functions and
load under plain Node once their specifiers resolve; `subscription-store.ts`,
`deletion-record.ts`, `account-deletion-sweeper.ts`, `orgs-beta.ts` and
`fth-tenant-setup.ts` were checked. `fth-orchestrator.ts` builds its
management client at module level and reads a linked secret while doing so, so
it and `service-orchestrator-registry.ts`, which imports it, throw at import.
Scripts can therefore import key builders, constants and pure helpers from
modules that defer their resource reads, and must keep resolving table names
from `sst state export` as they do now.

## Decision

Make the sources of `@filone/shared`, `@filone/rag-shared` and
`@filone/backend` loadable by plain Node, and have lint keep them that way.

**Relative imports name the `.ts` file.** Every relative specifier ends in
`.ts`, and so does every cross-package deep import, so the backend imports
`@filone/shared/src/api/tenants.ts`. TypeScript already allows this:
`allowImportingTsExtensions` is on in the base tsconfig, and 57 files in the
repository use the form, including the generated API clients the backend
bundles into every Lambda. esbuild, Vite and vitest resolve it without
configuration.

**Enums become const objects.** Each `enum X` becomes
`export const X = { ... } as const` with a same-named type alias
`export type X = (typeof X)[keyof typeof X]`. Member access such as
`OrgRole.Owner`, type positions and `Object.values(X)` keep working unchanged.
The four `z.enum(X)` schemas that take an enum object accept the const object
in zod 4 without change; a probe file type-checked and parsed correctly. The
four classes with constructor parameter properties (`invitations.ts`,
`bulk-delete-jobs.ts`, `hubspot-client.ts` and a test double in
`bulk-delete-queue.test.ts`) get explicit field declarations.

**Type-only imports say so.** The ten sites that import a type without the
`type` keyword get it, which oxlint's `consistent-type-imports` can apply
automatically.

**Lint hardening.** Three guards land, each in the pull request that makes the
code comply with it, so `main` never fails lint:

- `verbatimModuleSyntax: true` in `tsconfig.base.json`. Under it TypeScript
  reports a type imported without `type` (TS1484), and oxlint's type-check pass
  surfaces the report in `pnpm lint`. A trial on the current tree reports 10
  errors, all at the sites named above and none in website or `bin/`.
- `erasableSyntaxOnly: true` in `tsconfig.base.json`. TypeScript reports every
  construct Node cannot strip (TS1294): enums, namespaces, parameter
  properties, `import x = require()`. A trial on the current tree reports 15
  errors: the ten enum declarations and five constructor parameter properties
  across four classes. None are in website.
- oxlint's `no-restricted-imports` with the pattern `*.js`, scoped by
  `overrides.files` to the packages already converted. On the current tree the
  rule fires on every import and export declaration whose specifier ends in
  `.js`, once per imported name, and on nothing else; no third-party specifier
  in the three packages ends in `.js`. It does not inspect `vi.mock()` or
  `import()` calls. The former never run under Node. The latter need their own
  guard: a rule in `@filone/oxlint-rules`, the repository's own oxlint plugin,
  that reports an `import()` whose string argument ends in `.js`. Shared and
  rag-shared have no dynamic imports today; the backend has 33, so the rule
  lands with the backend rewrite. `import/extensions` was tried and rejected
  because it also fires on website's extension-less imports.

TypeScript offers no option that forbids the `.js` form. Under both `NodeNext`
and `Bundler` resolution it maps `./x.js` to `x.ts` by design, and the mapping
has no switch. Its contribution here is the two flags above, which describe
what Node can execute rather than what the bundler can resolve.

Website keeps its 597 `.js` specifiers until a separate decision. Vite never
needed either form, and nothing in `bin/` imports the console. Converting it
is a single `sed` for one convention across the monorepo; leaving it costs two
conventions. The lint rule's `overrides` scope records whichever is chosen.

## Execution plan

Each pull request leaves the repository in a state worth keeping if the
sequence stops after it. Guards ship with the code they guard.

**1. Type-only imports.** Add `type` at the ten sites in nine files, fix the
`aws-lambda` import, turn on `verbatimModuleSyntax`. If the sequence ends
here, every import survives type stripping and a class of bugs that only the
bundle hides is closed. The merge cost is small; several of the nine files are
also edited by the IAM M2 stack.

**2. Enums and parameter properties.** Convert the ten enums and the four
classes, turn on `erasableSyntaxOnly`. After this step the sources contain
only syntax Node strips. Fourteen declarations change, plus any call
site the type alias does not cover. None of the 27 open pull requests edits an
enum declaration, so this step merges without conflict.

**3. Shared packages to `.ts` specifiers.** Rewrite `@filone/shared` and
`@filone/rag-shared` (143 import lines), add the `no-restricted-imports`
override for those two packages. After this step `@filone/shared` loads under
plain Node, and `bin/` can import `Stage`, `S3Region`, `OrgRole` and the API
constants instead of copying them. Shared goes before backend because a
backend module that imports `@filone/shared` cannot load until shared's own
internal specifiers resolve, whatever the backend's specifiers say.

**4. Defer resource reads in the FTH orchestrator.** Make
`fth-orchestrator.ts` create its management client on first use instead of at
module level, and export the console user code the `fth-console-key` script
mirrors. A small pull request with no other change, so that after step 5 the
orchestrator registry and everything it imports load under plain Node. Each
step 6 pull request repeats the check for its own source module before
deleting the mirror.

**5. Backend to `.ts` specifiers.** Rewrite the backend (1236 import lines,
179 `vi.mock` calls, 33 dynamic imports), widen the lint override, add the
`import()` rule. After this step every backend helper that defers its
resource reads loads under plain Node. This is the step with the merge cost
described below; schedule it right after the ready IAM M2 pull requests land.

**6. Replace the mirrors.** One script at a time, import the canonical module,
delete the copy and its "keep in sync" comment, and delete the mirror-equality
tests in `bin/lib`. Each script is its own pull request and its own runbook
check.

**7. Website, optional.** The same `sed` and the same override, if one
convention is preferred.

The rewrite in steps 3 and 5 is one command per package and takes seconds, so
the branch is created on the day it merges rather than kept alive.

## Impact on open pull requests

A trial merge of the specifier rewrite against each of the 27 open pull
request branches on 2026-09-08 gives the table below. Counts are files that
plain git leaves in conflict, which is what the GitHub merge check shows. The
rewrite adds no conflict to 14 of the 27, including the five ADR pull requests.
Every conflict is an import block where the pull request added or changed an
import line next to lines the rewrite changed; none involve logic. The trial
rewrote import clauses only, so branches that also edit `vi.mock` calls in
test files will see a few more.

| PR   | Branch                                 | Status | Conflicting files      |
| ---- | -------------------------------------- | ------ | ---------------------- |
| #675 | iam-m2/transfer-and-removal            | draft  | 18                     |
| #686 | iam-m2/mint-sequence-fence             | open   | 14                     |
| #674 | iam-m2/revoke-on-narrowing             | draft  | 14                     |
| #673 | iam-m2/shared-mailer                   | open   | 7                      |
| #672 | iam-m2/role-change-preview             | open   | 7                      |
| #671 | iam-m2/revoke-key-lib                  | open   | 4                      |
| #670 | iam-m2/key-ceiling                     | open   | 3                      |
| #669 | iam-m2/access-model                    | open   | 1                      |
| #685 | filipa/multi-org-polish                | draft  | 8 new, 4 pre-existing  |
| #523 | spike/lance-vector-store               | draft  | 8 new, 16 pre-existing |
| #654 | filipa/polish-usage-trends             | open   | 3                      |
| #658 | filipa/fil-996-honest-dashboard-counts | open   | 2                      |
| #415 | security/fil-339-rate-limit            | open   | 1                      |

The IAM M2 branches are stacked in the order listed, with #675 on top, so
their counts are cumulative and only the top of the stack has to be rebased.
Landing step 5 after #686 merges leaves #675 above it and the five unrelated
branches, about 40 files in total.

Resolution is mechanical. Every conflict resolves by taking the pull request's
side of the import block and re-running the rewrite command on the file.
Running the rewrite on the pull request branch before rebasing does not help:
git conflicts on overlapping regions, and identical `.ts` lines on both sides
still sit inside regions that differ. A structural merge tool changes the
picture. In a trial with mergiraf as the git merge driver, merges of #686 and
#675 went from 14 and 18 conflicting files to 1 and 2, #685 kept only its 4
pre-existing conflicts, and a rebase of the whole stack stopped once, on
`transfer-ownership.ts`. One merged file was inspected and carried `.ts`
specifiers together with the pull request's added imports. mergiraf is a
developer's local tool and the plan does not depend on it.

## Alternatives Considered

### A Node resolve hook that retries `.js` as `.ts`

A twelve-line `module.registerHooks` file, loaded with `--import`, resolves the
backend's specifiers without touching them. Tested against subscription-store,
orgs-beta, the FTH tenant setup and the deletion sweeper, it works once
`--experimental-transform-types` is added for the enums. Both flags must be on
the command line, because Node resolves an entry file's static imports before
any of its code runs, so a script cannot install the hook for itself. The
working invocation is an `env -S` shebang and `./bin/x.ts`; the documented
`node bin/x.ts` form fails with an unrelated-looking error. Rejected: two
experimental flags in every shebang, one repo-specific loader nobody outside
the team will recognize, and the backend stays unloadable by anything else.

### Leaf modules inside the backend

Move the mirrored constants and key builders into backend modules with no
relative imports and no enums, and let `bin/` import them by `.ts` path. It
needs no flags and no sweep, and `deletion-record.ts` shows it working today.
Rejected as the end state, kept as a fallback: nothing stops the next
contributor adding a relative import to a leaf, so each leaf needs a test that
loads it under plain `node`, and the enum blocker in `@filone/shared` remains.

### A new shared package

The leaf-module idea with a package boundary. The package still has to use
`.ts` specifiers and avoid enums internally, so it inherits the rewrite in
miniature, and `OrgRole`, `SubscriptionStatus` and `S3Region` stay in
`@filone/shared`, which `bin/` still cannot load. More ceremony for the same
result as leaf modules.

### A build step

Have tsc emit JavaScript to `dist/` and point `bin/` at it. Every production
runbook gains a build step and a stale-`dist` failure mode. Rejected: the
sources can be made loadable instead.

### A TypeScript runner such as tsx or vite-node

Solves everything with no repository change. Rejected by the project's
standing rule that scripts run on plain Node without a wrapper.

## References

- Node.js, "Modules: TypeScript", type stripping and the transform-types flag:
  https://nodejs.org/api/typescript.html
- TypeScript, `erasableSyntaxOnly` (5.8) and `verbatimModuleSyntax` (5.0):
  https://www.typescriptlang.org/tsconfig/#erasableSyntaxOnly,
  https://www.typescriptlang.org/tsconfig/#verbatimModuleSyntax
- TypeScript module resolution reference, which documents the `.js` to `.ts`
  mapping: https://www.typescriptlang.org/docs/handbook/modules/reference.html
- `bin/lib/billing-rekey.test.ts`, the mirror-equality test this decision
  makes unnecessary
