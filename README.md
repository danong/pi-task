# pi-task

A task-execution engine for the [pi coding agent](https://pi.dev): isolated
worker sessions, bwrap sandboxing, typed schema-validated yields, budget tiers,
and adversarial review. The user-facing experience is like other coding
harnesses: you chat, and the conversational agent decides whether to edit
directly or dispatch work to workers.

The engine is enforced by code rather than by the LLM: task completion and test
passes are gated by typed contracts and real bash exit codes; a strong model
plans, then the session swaps to a fast model on the first edit; parallel
workers run in isolated jj workspaces and are merged back with conflicts
surfaced. See `docs/pi-task-design.md` for the full design.

## Install

Requires jj (>= 0.43), node, python3 (config TOML is parsed via tomllib), and a
working `pi` install. Dev/test dependencies are provisioned through the repo's
`mise.toml`:

```sh
mise run setup     # npm ci, gated on file staleness — skipped when node_modules
                   # is newer than package.json/package-lock.json
mise run verify    # toolchain gate (tsx, pi deps, python3 tomllib,
                   # shipped-config drift)
mise run test      # full hermetic test suite, zero LLM calls
```

The repo ships `.pi/settings.json` registering itself as a project package
(`"packages": [".."]`), so any trusted checkout auto-installs — the `task`
tool, `/task-budget` command, and `--task-budget` flag are available on the
next session. For a global (non-project) install instead:

```sh
pi install /path/to/this/repo
```

`pi install` adds the package to the pi agent dir's `settings.json` (`packages`)
and the `task` tool, `/task-budget` command, and `--task-budget` flag become
available after `/reload`.

## Configuration

`task.toml` is the config surface: the loader (`loadTaskConfig()` in
`extensions/task/config.ts`) reads `<pi agent dir>/config/task.toml` (default
`~/.pi/agent`) — a missing file falls back to built-in defaults, so a fresh
install works without any config; the agent-dir copy is where per-machine
overrides belong. The sections it can contain — see `config/task.toml` and
`extensions/task/config.ts` for the full surface, including but not limited
to:

- `[defaults]` — run-wide defaults: the effective budget mode for unlocked
  runs, the fix-loop iteration cap, the per-tool-call timeout, and the AI
  commit identity used for task-worker commits.
- `[budget.*]` — budget tiers: the models used for prewalk, execution, and
  review, plus a per-tier wall-clock budget. Tiers are dynamic: every
  `[budget.*]` section is a usable tier, in file order, so adding a tier needs
  no code change.
- `[sandbox]` — worker bwrap sandbox policy: enable/disable, network mode,
  and extra bind paths.

The shipped `config/task.toml` in this repo is the drift-guarded mirror of the
built-in defaults: a hermetic test fails if they diverge
(`testShippedConfigMatchesDefaults()` in `extensions/task/test-config.ts`,
exercised by `mise run verify` and `mise run test`). Your agent-dir copy may
legitimately diverge — that is where overrides belong. `config/repo-map.toml`
(agent dir) configures the cached codebase-map used to seed worker context,
falling back to built-in defaults when missing.

## Testing

```sh
mise run test                                    # full hermetic suite, zero LLM calls
npx tsx extensions/task/test.ts                  # same suite, run directly
timeout 900 npx tsx extensions/task/test-e2e.ts  # one real-LLM e2e, manual
```

`mise run test` runs the full hermetic suite in one process (zero LLM calls);
`npx tsx extensions/task/test.ts` is the same suite as a direct command. The
real-LLM e2e (`extensions/task/test-e2e.ts`) stays manual and is intentionally
not part of `mise run test`.

## How it stays location-independent

The engine resolves the pi agent dir via `getAgentDir()` from
`@earendil-works/pi-coding-agent` (never from its own file path), so the package
works from any install location — local checkout, `~/.pi/agent/npm/`, or
`~/.pi/agent/git/`. Worker-side extension files (`tools/*.ts`) are loaded by
absolute path relative to the package, and the worker sandbox binds the agent
dir read-only (except pi's runtime-state paths) so workers never escape their
workspace.
