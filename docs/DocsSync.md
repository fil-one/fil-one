# Docs Sync

The workflow `.github/workflows/docs-sync.yaml` checks each product PR for
changes that make [docs.fil.one](https://docs.fil.one) wrong or incomplete.
When it finds some, it drafts the docs change as a pull request in
[FilecoinFoundationWeb/filone-docs](https://github.com/FilecoinFoundationWeb/filone-docs)
and asks the product PR's author to review it.

The docs have drifted from the product often enough to need three manual
audits (FIL-830, FIL-867, FIL-1563). This moves the check to the moment the
drift is introduced, when the author still has the context.

## Docs are part of the definition of done

The first line of defence is the author, not this workflow. The Documentation
section of `AGENTS.md` makes a docs update part of finishing any user-facing
change, so Claude Code does it as part of the task. The PR template asks every
author to link the docs PR, say why none is needed, or mark the change as
feature-gated.

When a PR's description links a `filone-docs` PR, this workflow still triages
it and posts the comment, so the author can check their docs PR covers every
claim. It drafts nothing, to avoid a second, competing docs PR. The description
is read when the workflow runs, so linking a docs PR later takes effect on the
next push or manual run.

## What a product PR author sees

1. One comment on the product PR, updated in place on every push:
   **Docs impact: none**, **docs need changes** (with a table of the pages and
   claims affected), or **unclear**.
2. When the docs need changes and the description links no docs PR, a draft PR in `filone-docs` on the branch
   `docs-sync/fil-one-<PR number>`, linked from that comment. It requests a
   review from the author and @-mentions them.
3. Each push to the product PR regenerates the docs PR, until a person pushes
   to the docs branch. From then on the bot leaves it alone and says so in the
   comment.
4. When the product PR merges, the docs PR is marked ready for review. When the
   product PR closes without merging, the docs PR is closed and its branch
   deleted.

Labels on the product PR steer it:

| Label          | Effect                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------- |
| `docs:skip`    | No triage and no draft for this PR.                                                         |
| `docs:gated`   | Triage only; no docs PR. Added automatically when triage finds a feature flag or beta gate. |
| `docs:ungated` | Overrides `docs:gated`, for a gated change that is already public.                          |

Label changes take effect on the next push, or on a manual run
(**Actions → Docs sync → Run workflow**). The workflow does not listen to label
events: with `cancel-in-progress`, adding an unrelated label would cancel a
running draft.

### Gated features and launches

A docs PR in a public repo announces the feature, even as a draft, and so does
the branch name. So gated work gets no branch and no PR, only the triage
comment, which lands on the product PR, which is already public. At launch,
run the workflow by hand with the product PR number and **force** checked.
This works on merged PRs too, which is the usual case: the flag flips long
after the code merged. To find the backlog of gated changes:
`is:pr is:merged label:docs:gated`.

If a docs PR already exists when a PR becomes gated (the gate was added late),
the workflow does not close it; close it by hand if the feature must stay
unannounced.

## Decisions

- **Runs on `pull_request`, never `pull_request_target`.** Fork PRs get no
  secrets under `pull_request`, and the workflow skips them explicitly. It also
  skips bots (Dependabot), authors who are not repo collaborators, and draft
  PRs, which run again on `ready_for_review`.
- **Path filters** limit runs to user-facing code: `packages/website/src`,
  `packages/shared/src`, `packages/backend/src`, `sst.config.ts`, and `infra/`.
  The diff Claude sees is narrowed further by `.github/docs-sync/paths.txt`,
  which leaves out tests, stories and test fixtures. Keep the two lists in step.
- **Two models.** Triage runs on every qualifying push, so it uses the cheapest
  model, Claude Haiku 5.5. Drafting public docs needs care, so it defaults to
  Claude Opus 5.5. The repo variable `DOCS_SYNC_DRAFT_MODEL` switches it (for
  example to `claude-sonnet-5-5`, at half the price) without a code change.
- **Structured output, rendered by code.** Both Claude steps return JSON
  against a schema (`triage-schema.json`, `draft-schema.json`). No model output
  is posted as-is: `docs-sync.mjs` validates it, drops pages that do not exist
  in the docs repo, and strips links, HTML, and @-mentions before anything
  reaches a comment or PR.
- **Claude never runs the build or git.** The draft step has Read, Glob, Grep,
  Edit and Write, and no Bash. A separate job with no secrets copies the edited
  files onto a clean docs checkout, checks them, and runs `npm run build`.
- **The prompts are read from the PR's base commit**, so a PR cannot change the
  instructions its own triage runs under. (A PR can still change the workflow
  file itself; see the threat model.)
- **`docs-site/AGENTS.md` is the rulebook.** Both prompts tell Claude to read
  the docs repo's `AGENTS.md` and follow it (both mirrors, verified claims
  only, per-region and per-surface accuracy, public region IDs). The
  `filone-code-auditor` agent in the docs repo inspired the triage prompt but
  is not loaded directly: it hard-codes local paths and is not committed.
- **One branch per product PR, force-updated.** Regenerating from scratch on
  each push is simpler and more predictable than patching the previous draft.
  The guard against overwriting a person's commits makes this safe.
- **Triage flipping to "none" does not close an existing docs PR.** That
  would flap on a noisy verdict; the comment says so and a person decides.

## Threat model

Both repos are public. Anyone can read the workflow, the prompts and every
run log. Only repo collaborators can trigger runs that have secrets.

| Threat                                                                                                                                                                                   | Mitigation                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A fork PR runs with secrets                                                                                                                                                              | `pull_request` gives forks no secrets; the `context` job also skips forks, bots, and non-collaborators.                                                                                                                                                                                                                         |
| Prompt injection in a PR's title, body, diff, code comments, or strings steers Claude                                                                                                    | Claude's GitHub token is the read-only `GITHUB_TOKEN`. Triage has only Read, Glob and Grep; drafting adds Edit and Write, and neither has Bash or web tools. Prompts tell Claude to treat PR content as data and to report text addressed to it. All writes happen in later jobs that run no model.                             |
| Injected output reaches users as a phishing link or ping                                                                                                                                 | `docs-sync.mjs` strips links, images, HTML and @-mentions from all model text, caps lengths, and builds every link itself from validated paths.                                                                                                                                                                                 |
| The draft edits files outside the docs content                                                                                                                                           | Only `docs/**/*.md(x)` and the two `static/llms*.txt` files are handed over; `check-draft` fails the run on any other changed path. `docusaurus.config.js`, `sidebars.js`, `vercel.json` and `src/` are executable or config, so Claude lists those changes as manual follow-ups.                                               |
| Executable MDX: the docs build runs MDX, so injected `export`, `<script>`, or `{process.env…}` would run at build time (in this workflow, in the docs repo's CI, and in Vercel previews) | `check-draft` rejects new lines outside code fences with `import` (other than the existing `@theme/Tabs` imports), `export`, `<script>`, `<iframe>`, event attributes, `javascript:` URLs and JavaScript expressions; the build job holds no secrets; new links to unknown hosts are flagged in the docs PR.                    |
| Claude plants a `.git/config` (for example a `core.fsmonitor` command) so a later git command runs it                                                                                    | The draft job runs no git after Claude. It uploads plain files; verify rebuilds the diff on a fresh clone.                                                                                                                                                                                                                      |
| A collaborator edits the workflow in a PR to exfiltrate secrets                                                                                                                          | Not preventable with `pull_request`: same-repo PRs get repo secrets, as they already do for the existing workflows. Bounded by least privilege: the App can only write to `filone-docs` contents and PRs, and `filone-docs` `main` is protected by a ruleset (PR, 1 approval, last-push approval). Spend-cap the Anthropic key. |
| The App token is used to push to `filone-docs` `main`                                                                                                                                    | The ruleset requires a PR and an approval; do not add the App to the ruleset's bypass list. The App is installed on `filone-docs` only, never on `fil-one`.                                                                                                                                                                     |
| Force-push destroys a person's work on the docs branch                                                                                                                                   | `publish` checks the branch's commits and stops when any is not from the App; it also stops when a docs PR for the branch was closed unmerged.                                                                                                                                                                                  |
| Bot PRs announce unreleased features                                                                                                                                                     | Gated changes get no branch or PR (see above).                                                                                                                                                                                                                                                                                  |
| Secrets leak into logs                                                                                                                                                                   | `display_report` and `show_full_output` stay off; no step echoes a token.                                                                                                                                                                                                                                                       |

Residual risks, accepted for v1:

- Claude can still be steered into a _wrong_ docs edit within the allowed
  paths. Every docs PR is a draft that needs human review and approval before
  merge, and the PR body says so.
- A wrong triage verdict of **none** means a missed update, which is today's
  status quo. The periodic `/docs-audit` remains the backstop.

## Cost

Prices from Anthropic's list at time of writing: Claude Haiku 5.5 $0.10 / $0.50
per million input / output tokens (prompts up to 100K tokens; $0.50 / $2.50
beyond); Claude Opus 5.5 $4 / $20 (cache reads $0.20); Claude Sonnet 5.5 $2 /
$10 (cache reads $0.20).

Volume: this repo had 83 human-authored PRs from 2026-09-21 to 2026-10-21. The
estimate below assumes about 70% touch the path filters, three triggering
events each (open or ready, plus two pushes), and a quarter of those PRs need
docs changes.

| Step                            | Runs / month | Tokens per run (estimate)           | Cost per run | Monthly |
| ------------------------------- | ------------ | ----------------------------------- | ------------ | ------- |
| Triage (Haiku 5.5)              | ~175         | 150K in, 4K out                     | ~$0.02–0.10  | ~$4–18  |
| Draft (Opus 5.5)                | ~45          | 400K in (most cache reads), 40K out | ~$1–2        | ~$45–90 |
| Draft (Sonnet 5.5, if switched) | ~45          | same                                | ~$0.50–1     | ~$25–45 |

GitHub Actions minutes are free on public repositories. Measure for the first
month: the per-run token counts are guesses, and drafting dominates. If it
runs high, the first levers are switching the draft model, or drafting only on
`opened` / `ready_for_review` and on manual runs rather than on every push.

## Setup (manual, by a repo admin)

None of this has been done yet. The workflow fails at the App token step until
it is.

### 1. Create a GitHub App for the docs repo

A GitHub App, rather than a personal access token: its tokens last an hour, are
scoped per run to one repo, and are not tied to a person's account. A
dedicated App, rather than reusing `fil-one-bot`, keeps that App's write
access to this repo out of a workflow that reads untrusted PR content.

1. Under the **FilecoinFoundationWeb** organization's settings, create a
   GitHub App (for example `filone-docs-sync`), with webhooks off.
2. Repository permissions: **Contents: Read and write**, **Pull requests: Read
   and write**, **Metadata: Read** (required). Nothing else, and no
   organization or account permissions.
3. Install it on **FilecoinFoundationWeb/filone-docs only**. It needs no access
   to `fil-one/fil-one`: reading the product repo uses this repo's own
   `GITHUB_TOKEN`.
4. Generate a private key and note the App's Client ID.
5. In `filone-docs` → **Settings → Rules**, confirm the App is not on the
   `main` ruleset's bypass list.

Fallback, if an App is not possible: a fine-grained personal access token from
a machine account, with access to `filone-docs` only, **Contents** and **Pull
requests** read and write, and the shortest expiry you can manage. Store it as
a `DOCS_SYNC_TOKEN` secret and replace the two `create-github-app-token` steps
with it. It is the weaker option: the token lives until it expires, not for one
run.

### 2. Add secrets and variables to `fil-one/fil-one`

```sh
gh secret set DOCS_SYNC_APP_CLIENT_ID --repo fil-one/fil-one
gh secret set DOCS_SYNC_APP_PRIVATE_KEY --repo fil-one/fil-one < path/to/filone-docs-sync.private-key.pem
gh secret set ANTHROPIC_API_KEY --repo fil-one/fil-one
```

Feed the PEM file directly to `gh`, not through the clipboard. For
`ANTHROPIC_API_KEY`, create a dedicated key in its own Anthropic Console
workspace with a monthly spend limit, so it can be revoked and capped without
touching other keys. Optional: set the repo variable `DOCS_SYNC_DRAFT_MODEL`.

Once it works, consider replacing the static key with Anthropic workload
identity federation: `claude-code-action` accepts
`anthropic_federation_rule_id` and `anthropic_organization_id` and exchanges
the run's GitHub OIDC token instead, which needs `id-token: write` on the two
Claude jobs and leaves no long-lived key to leak.

### 3. Create labels

```sh
gh label create docs:skip --repo fil-one/fil-one --description "Docs sync: skip this PR"
gh label create docs:gated --repo fil-one/fil-one --description "Docs sync: feature-gated, hold docs PR until launch"
gh label create docs:ungated --repo fil-one/fil-one --description "Docs sync: override docs:gated"
gh label create docs-sync --repo FilecoinFoundationWeb/filone-docs --description "Drafted by the fil-one docs sync workflow"
```

### 4. Docs repo access for product engineers

Requesting a review from the product PR's author works only if they are a
collaborator on `filone-docs`; otherwise the request is skipped with a warning
and the @-mention in the PR body notifies them. Give product engineers at least
**Read** on `filone-docs` (and **Write** if they should approve docs PRs).

### 5. First run

Open a small PR that changes a console label the docs mention, and check that
the comment, the docs PR, and its build all appear. The first run is also
where to confirm that `claude-code-action` runs with the read-only
`GITHUB_TOKEN` without trying to write a tracking comment, and that
`--json-schema` returns `structured_output` as expected. (`npm ci
--ignore-scripts` followed by `npm run build` was checked locally against
`filone-docs` `main`.)

## Files

- `.github/workflows/docs-sync.yaml`: the workflow.
- `.github/docs-sync/triage-prompt.md`, `draft-prompt.md`: the prompts.
- `.github/docs-sync/triage-schema.json`, `draft-schema.json`: structured output schemas.
- `.github/docs-sync/docs-sync.mjs`: validation, comments, checks, PR body.
- `.github/docs-sync/paths.txt`: the diff Claude sees.
- `AGENTS.md` (Documentation) and `.github/pull_request_template.md`: docs in
  the definition of done.
- In `filone-docs`: `.github/workflows/build.yaml` builds every docs PR, and
  `AGENTS.md` has a section on how drafted PRs are handled.
