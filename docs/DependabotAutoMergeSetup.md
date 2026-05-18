# Dependabot Auto-Merge Setup

The workflow `.github/workflows/dependabot-auto-merge.yml` enables auto-merge
on Dependabot PRs. It authenticates as the `fil-one-bot` GitHub App — an
installation access token is minted at run time via
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token)
— so the merge commit is attributed to `fil-one-bot[bot]`.

The automatic `GITHUB_TOKEN` is deliberately not used. Per GitHub's
[Triggering a workflow from a workflow][trigger-from-workflow] docs, _"events
triggered by the `GITHUB_TOKEN`, with the exception of `workflow_dispatch` and
`repository_dispatch`, will not create a new workflow run"_. That rule
prevents recursive runs, but it also means a `GITHUB_TOKEN`-authored merge
into `main` would skip downstream workflows (e.g., deployments). The same
page names a GitHub App installation access token (or a PAT) as the
supported escape hatch; this workflow uses the former.

[trigger-from-workflow]: https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow

## Prerequisites

The `fil-one-bot` GitHub App is already created and installed on this
repository with **Pull requests: write** and **Contents: write** permissions.
This runbook only covers wiring its credentials into the workflow.

## Setup

Dependabot-triggered workflows cannot read regular Actions secrets; they can
only read Dependabot secrets. Store both values with `--app dependabot`.

1. On the fil-one-bot App's settings page, scroll to the **Private keys** section. Click **Generate
   a private key**; the browser downloads a PEM file (e.g.
   `fil-one-bot.2026-04-21.private-key.pem`).
2. Upload the downloaded PEM as the `FIL_ONE_BOT_PRIVATE_KEY` secret. Feed the
   file directly to `gh` — do not paste it via the clipboard, which may mangle
   line endings on some terminals:
   ```sh
   gh secret set FIL_ONE_BOT_PRIVATE_KEY --app dependabot < path/to/fil-one-bot.*.private-key.pem
   ```
3. Copy the App's Client ID from the same settings page (it looks like
   `Iv23li...`) and store it:
   ```sh
   gh secret set FIL_ONE_BOT_CLIENT_ID --app dependabot
   ```
