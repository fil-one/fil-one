# Working with stacked PRs (`gh stack`)

How to update a stack of PRs managed with the [GitHub Stacks CLI](https://github.com/github/gh-stack)
(`gh extension install github/gh-stack`). Written for the FIL-112 stack but the
recipes apply to any merge-based stack in this repo.

**The FIL-112 stack (bottom → top):**

1. `srdjan/fil-112-1-orchestrator-primitives` (#539)
2. `srdjan/fil-112-2-billing-deletion-guard` (#540)
3. `srdjan/fil-112-3-deletion-challenge` (#541)
4. `srdjan/fil-112-4-deleted-session-handling` (#542)
5. `srdjan/fil-112-5-account-teardown` (#543)
6. `srdjan/fil-112-6-deletion-reconciler` (#544)
7. `srdjan/fil-112-as-a-user-…` (#497, website UI — carries the original review history)

## Orientation

```bash
gh stack view      # show the chain with PR links
gh stack switch    # interactive branch picker
gh stack up        # check out the next branch up the stack (gh stack down: toward trunk)
```

## Recipe 1 — change something in one layer (the common case)

Commit on the layer that **owns** the file, then carry the change upward with
merges. Rule of thumb for ownership: the lowest branch whose PR diff contains
the file — fixing it there puts the change in front of the reviewer who has
the context, and every PR above inherits it.

```bash
git switch srdjan/fil-112-3-deletion-challenge   # the owning layer
# ...edit, test...
git commit -m "fix: ..."

# propagate up the chain (each merge is usually trivial or a no-op)
git switch srdjan/fil-112-4-deleted-session-handling && git merge srdjan/fil-112-3-deletion-challenge --no-edit
git switch srdjan/fil-112-5-account-teardown        && git merge srdjan/fil-112-4-deleted-session-handling --no-edit
# ...continue through 6 and the top branch...

gh stack push    # pushes every active branch (force-with-lease; these are fast-forwards)
```

## Recipe 2 — main moved, or the bottom PR merged

Resolve conflicts once, at the bottom, then cascade:

```bash
git switch srdjan/fil-112-1-orchestrator-primitives
git merge origin/main --no-edit
# cascade merges up as in Recipe 1, then gh stack push
```

When a bottom PR **merges**, GitHub retargets the next PR to `main`
automatically; merge `origin/main` into the new bottom branch and cascade.

## Recipe 3 — PR metadata / restructuring the stack

```bash
gh stack submit          # push + create/update PRs; interactive editor for titles/bodies
gh stack submit --auto   # non-interactive (new PRs are drafts; add --open for ready)
gh stack modify          # TUI to reorder/rename/insert/drop layers — run submit afterward
```

## Merging the finished stack

```bash
gh stack merge    # merges the PRs in order, bottom to top
```

Or merge bottom-up one PR at a time to let staging deploys bake between
layers — each layer is independently deployable by construction.

## ⚠️ Things to avoid on a merge-based stack

- **Don't run `gh stack sync` or `gh stack rebase`.** Both cascade-**rebase**
  and force-push every branch. The FIL-112 stack is deliberately merge-based,
  and the top branch is PR #497 with long review history — rewriting it breaks
  every review-thread anchor. Use the merge recipes instead.
- **Never force-push the top branch** for the same reason.
- Use `pnpm exec <tool>` (or the repo scripts), not `pnpx <tool>` — `pnpx`
  fetches unpinned registry versions that can diverge from CI's pinned ones.
- `oxfmt` occasionally needs two `--write` passes to converge on a file; if
  CI's format check fails right after you formatted, run `pnpm run lint:fix`
  again before digging deeper.
