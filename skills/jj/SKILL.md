---
name: jj
description: >-
  Jujutsu (jj) VCS. Load for any version-control task: committing, squashing,
  pushing, rebasing, bookmarks, workspaces, ignore files, undo, and git interop
  in colocated repos. Read before running jj or git commands — the pi-task
  cookbook at the bottom covers engine-managed repos (worker merges, recovery).
---

# jj (Jujutsu)

jj is a Git-compatible VCS of revisions and anonymous branches. The working copy
is always a commit (`@`); jj auto-snapshots it on nearly every command — there is
no `add`/stage step.

**More detail when you need it:** `jj <command> --help`; `jj help -k tutorial`;
`jj help -k revsets`, `-k filesets`, `-k templates`, `-k bookmarks`;
`jj util markdown-help` (full CLI reference).

## Rules

- **Never push or move a bookmark unless explicitly asked.**
- **Default to `main`.** Work on `main`, push `main`. Bookmarks, PRs, and
  workspaces are situational (OSS/team repos, parallel agents) — not the default.
- `jj op restore <op-id>` undoes almost any mistake. Recover; never `--force` push.
- `main@origin` is immutable by default (`immutable_heads()` = `trunk()`), so
  pushed history can't be rewritten without `--ignore-immutable`. Verify:
  `jj config get revset-aliases.immutable_heads`.

## Default workflow

```sh
# 0. Pick up remote work before starting (skip if no git remote).
jj git fetch
# 1. Edit files — @ accumulates the changes automatically.
jj st                          # review what changed
# 2. Finalize the change with a message; also starts a fresh empty @.
jj commit -m "feat(scope): summary

body

#PI"
# 3. Repeat per logical step, then collapse intermediates into one commit:
jj squash                      # see Squashing for ranges
# 4. Advance main and push (only when asked). The finished commit is @-.
jj bookmark move main --to @-
jj git push --bookmark main
```

### Integration modes (who pushes what)

The steps above assume the **solo-main** workflow: one author, finished work
lands on `main`, `jj git push --bookmark main`. In a **multi-author** repo,
never move `main` yourself — publish a named bookmark per unit of work and
let the review process advance main:

```sh
jj bookmark create feat/my-change -r @-   # named bookmark on the finished commit
jj git push --bookmark feat/my-change     # PR-style; remote review advances main
```

`jj git push --change @-` is the anonymous alternative (creates/updates
`push-<changeid>`) — right for quick shares, clutter for durable work.
Never rewrite commits visible on a remote you don't own: immutable-by-default
(`immutable_heads()`) already protects `main@origin`.

Commit format: `type(scope): summary` + body + trailing `#PI` (scope required).
`jj commit` = `jj describe -m` + `jj new`. **Don't run `jj new` after `jj commit`**
— it makes a redundant empty commit. Use `jj describe -m` alone only to reword an
existing commit.

## Reference

### Log & diff
```sh
jj log                        # default: mutable commits + immediate context
jj log -r "all()"             # entire repository history
jj log -r "ancestors(@, 10)"  # last 10 commits
jj diff --from "roots(ancestors(@, 10))" --to "@" --git   # diff of last 10
```
- Default `jj log` shows only **mutable** commits — active/unpushed work plus
  immediate context — hiding immutable history like `main`/`trunk`.
- `jj log -r "all()"` reveals the entire repository history.
- `ancestors(@, 10)` limits to the last 10 commits; `roots(...)` in `--from`
  spans that whole range when diffing.
- **Always pass `--git` to `jj diff`** — it emits a standard git-style diff that
  is machine- and LLM-friendly.

### Squashing
```sh
jj squash                        # move @ changes into its parent (@-)
jj squash -r REV                 # squash REV into its parent
jj squash --from SRC --into DST  # move SRC's changes into a specific target
```
- Squash **bottom-up** (closest parent first); skipping a middle commit rewrites
  its parent and causes conflicts.
- Prefix `JJ_EDITOR=true` to skip editor prompts (squash/describe/rebase).

### Pushing
```sh
jj git push --bookmark main        # default: push the main bookmark
jj git push --change @-            # PR-style: creates/updates branch push-<changeid>
jj git push --dry-run --change @-  # preview first
```
- `--change` creates a **new branch on every push** — right for PRs, clutter for
  solo repos. Solo repos push `main`.
- Pushing a bookmark sends all commits from the remote's position to the target.

### Rebase
```sh
jj rebase -s SRC -o DEST         # SRC (+descendants) onto DEST
jj rebase -b BRANCH -o DEST      # whole branch onto DEST
jj rebase -r REV -o DEST         # just REV; descendants fill the hole
```
- Use `-o`/`--onto`; `-A`/`--insert-after` and `-B`/`--insert-before` place the
  revision relative to the target. Repeat `-o` to make a merge commit.

### Conflicts
- jj keeps conflicts **in the commit** (it does not abort the merge); the working
  copy shows conflict markers. Resolve by editing the markers, then let jj snapshot.
- Or use a tool: `jj resolve` (3-way merge), `jj resolve --list` to list conflicts,
  `jj resolve --tool :ours` / `:theirs` to take one side. `-r <rev>` targets a
  revision other than `@`.

### Bookmarks
```sh
jj bookmark list                 # --all-remotes for remote state
jj bookmark set NAME -r <rev>    # create or move
jj bookmark move NAME --to <rev>
```
- `bookmark move` refuses backwards/sideways; pass `--allow-backwards` only after
  verifying: `jj log -r 'ancestors(TARGET)'`.

### Workspaces
A workspace is jj's worktree: an extra working copy on the **same repo** (shared
commits + op log; its own working-copy commit + sparse patterns). Only for
isolated work (parallel agents, long builds) — not everyday solo work.
```sh
jj workspace add ../proj-<name>    # shares current @'s parent; -r <rev> to set
jj workspace list
jj workspace forget <name>         # then delete the directory yourself
```
- One workspace per concurrent agent so working copies don't collide.
- Commits/op log are shared; a rewrite elsewhere can leave a workspace **stale**
  → `jj workspace update-stale`.
- `jj sparse set` limits which paths a workspace materializes.

### Ignore & tracking
- jj reads `.gitignore` (no `.jjignore`).
- Ignored files are never auto-tracked, but **already-tracked files stay tracked**
  when later ignored → `jj file untrack <paths>` (paths must be ignored first).
- `jj git init` snapshots everything **before** a later `.gitignore` applies —
  write `.gitignore` first or untrack secrets after.
- `jj file list` is the authoritative tracked set.
- Deny-by-default allowlist: `/*` then un-ignore safe paths (`!/src/`, ...).

### Git interop
Colocated repos (`jj git init --colocate`) have `.jj` + `.git`; jj auto-exports.
- The commit-id **is** the git SHA:
  `SHA=$(jj log -r @- -T 'commit_id' --no-graph | head -1)`.
- **`git ls-tree @-` is a false pass** — `@-` isn't a git ref (empty tree). Use
  `git ls-tree -r --name-only "$SHA"` and `git show "$SHA:<path>"`.
- **`git check-ignore` lies** for files jj already indexed (it consults the index
  by default). Use `git check-ignore --no-index`, or trust `jj file list`.

### Undo & recovery
```sh
jj op log                      # find the op id
jj op restore <op-id>          # restore repo to that op (universal undo)
jj op revert [<op-id>]         # revert one op (default: last)
jj undo / jj redo              # step backward/forward through ops
jj restore <paths>             # discard working-copy changes (from parent)
jj abandon <rev>               # abandon a revision; descendants rebase onto parent
```
- Lost a commit → find it in `jj op log` or `jj evolog -r <change>`, then restore.

### Bisect
- Find the commit that broke something:
  `jj bisect run --range <good>..<bad> -- <command>`. jj binary-searches the
  range; the command's exit code judges each commit (0 = good, non-zero = bad,
  125 = skip). `--find-good` inverts the search.

## Common mistakes
- Running `jj new` after `jj commit` (redundant empty commit).
- Passing `@`/`@-` to git commands (resolve `commit_id` first).
- Trusting `git ls-tree @-` or `git check-ignore` (both mislead; see Git interop).
- Expecting new ignore rules to untrack files (use `jj file untrack`).
- Reaching for branches/`--change` on a solo repo (push `main`).

---

# pi-task cookbook

How the task engine uses jj, and how to operate the repos it manages — for
conversational agents working in a pi-task project (this section is additive;
the cheatsheet above applies everywhere).

## How the engine uses jj

- **Fetch before work**: workspace provisioning runs `jj git fetch` when a
  git remote exists (non-fatal when it doesn't — local-only repos must
  work), so workers never build on stale remote state.
- **Integration modes** (config, default `task-base`): `task-base` combines
  every worker's commits into the AI-authored task base in ONE atomic
  operation; `feature-branch` skips the combine and leaves each worker's
  commits stacked on the base under named bookmarks for human review. The
  engine NEVER pushes — publishing is always the operator's act, under
  whichever integration mode the repo uses.
- **Parallel workers run in isolated workspaces** (`jj workspace add` per
  worker, rooted at the task base). Each worker commits per requirement in its
  own workspace; afterwards the engine combines every workspace's commits into
  the task base in **ONE atomic operation**:
  `jj squash --from '<base>..<ws1-@>|<base>..<ws2-@>' --into <base>`
  (revset union is `|` — `+` is not a binary operator in jj 0.43 revsets).
- **Textual conflicts resolve deterministically** via the union ladder: jj 3-way
  first, then `jj resolve --tool union` (a custom merge tool backed by
  `git merge-file --union`), then LLM/manual escalation with only the conflicted
  hunks. The verification gate never runs on unverified or conflicted work.
- **Every jj call is bounded** (`execJj` timeouts) so a wedged store can never
  hang the engine.

## Reading a run's state

- The run's merged result is `@-` (an empty `@` working copy sits on top). Its
  diff vs the pre-run base is the workers' work:
  `jj diff --from <base> --to @- --git`.
- A completed run's manifest records the merged commit id (`config.shape`,
  phases, merge record) under `<agent-dir>/results/<project>/`.
- A failed run leaves a `.failure.json` artifact carrying a **recovery guide**
  (stacking commands, stub cleanup, conflict warnings) — read it before
  touching the repo.

## Merge-recovery playbook

When a parallel run fails after merging (or a worker aborts), the workspaces
are PRESERVED — their commits still live in the repo. Recover manually:

1. **Find the workspaces and their commits**: `jj workspace list` +
   `jj log -r all()` (the worker commits carry the sub-spec descriptions).
2. **Stack the preserved workspaces** onto the task base, one at a time, in
   dependency order, then squash them in:
   `jj rebase -s <workspace-commit> -o <base-commit>` then
   `jj squash --from <base-commit>..<workspace-tip> --into <base-commit>`.
   **Re-resolve ids AFTER every command** — rebase rewrites commit ids; a
   captured id goes stale.
3. **BEFORE pushing, abandon the AI task base and any empty working-copy
   stubs** — jj refuses to push description-less commits:
   `jj abandon <commit-id>` for every commit with an empty description, then
   verify `jj log -r all()` shows none.
4. **A resolution commit ON TOP of a conflicted commit does NOT clear the
   parent's conflict for `jj push`** — jj refuses to push any commit whose
   tree carries conflict markers, even when a descendant resolves them.
   Squash the resolution INTO the conflicted commit:
   `JJ_EDITOR=true jj squash -r <resolution-commit>` (it merges into its
   parent), then push.
5. **Add-vs-delete conflicts** (a file deleted on one side, kept on the other)
   resolve via `:ours`/`:theirs` — NOT mid-stack `abandon` (abandoning a
   commit mid-stack silently drops whichever side the abandoned commit held):
   `jj resolve --tool :ours -r <commit> <path>` (keep the modified side) /
   `jj resolve --tool :theirs -r <commit> <path>` (keep the deletion).
6. **Run the full verification gate on the merged tree** before considering the
   merge done.

## Footguns

- **`jj squash --from X --into Y` with `@` as a descendant can re-root the
  working copy** (its tree goes empty; the content lands in the target).
  Always check `jj status` after an `--into` squash; recover with
  `jj rebase -s @ -o <feature>` if the working copy detached.
- **`jj new` after `jj commit`** is redundant (the commit already opens a fresh
  empty `@`).
- **Abandoned commits are recoverable**: `jj op log` + `jj op restore`, or
  `jj evolog -r <change>` — never assume a commit is gone.
