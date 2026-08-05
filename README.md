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
working `pi` install. Install the package (local path, git, or npm source):

```sh
pi install /path/to/this/repo
```

`pi install` adds the package to the pi agent dir's `settings.json` (`packages`)
and the `task` tool, `/task-budget` command, and `--task-budget` flag become
available after `/reload`.

## Configuration

The loader reads `<pi agent dir>/config/task.toml` (default `~/.pi/agent`) — a
missing file falls back to built-in defaults, so a fresh install works without
any config. The shipped `config/task.toml` in this repo is the drift-guarded
mirror of those defaults (a hermetic test fails if they diverge); your agent-dir
copy is where per-machine overrides belong. Budget tiers are dynamic: every
`[budget.*]` section is a usable tier, in file order. `config/repo-map.toml`
(agent dir) configures the cached codebase-map used to seed worker context.

## Testing

```sh
npm install
npx tsx extensions/task/test.ts        # hermetic fast suite, zero LLM calls
timeout 900 npx tsx extensions/task/test-e2e.ts   # one real-LLM e2e, manual
```

## How it stays location-independent

The engine resolves the pi agent dir via `getAgentDir()` from
`@earendil-works/pi-coding-agent` (never from its own file path), so the package
works from any install location — local checkout, `~/.pi/agent/npm/`, or
`~/.pi/agent/git/`. Worker-side extension files (`tools/*.ts`) are loaded by
absolute path relative to the package, and the worker sandbox binds the agent
dir read-only (except pi's runtime-state paths) so workers never escape their
workspace.
