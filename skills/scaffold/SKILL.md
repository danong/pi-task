---
name: scaffold
description: >-
  Setting up a new project: the standard stub files (AGENTS.md, CONTEXT.md,
  docs/adr/, README.md, .gitignore, mise.toml, .pi/settings.json) and asking
  whether to also initialize jj/git + mise trust to match the usual
  conventions. Load when the user asks to scaffold or initialize a repo,
  create "the usual files", or the repo is near-empty and setup would help.
---

# Scaffold

Create the standard project stubs, then **ASK the user about environment
setup** — never run setup commands without asking.

## The standard files

Create each with minimal stub content; the user fleshes them out later:

- **`AGENTS.md`** — agent instructions for THIS repo (project-level rules;
  the global rules already apply).
- **`CONTEXT.md`** — the shared domain language: glossary-style names for
  the repo's hard-to-explain concepts, so the agent and workers speak one
  language (the workflow contract, delegation skill, and surveys read it).
  Stub: the core concepts with one-line definitions, leaving gaps.
- **`docs/adr/`** — architecture decision records (one file per decision:
  context / decision / consequences). Stub: a `README.md` explaining the
  format + a template file.
- **`README.md`** — one paragraph: what the project is.
- **`.gitignore`** — `node_modules/`, `.pi/sessions/`, `.pi/npm/`,
  `.pi/git/`, `results/`, `cache/`.
- **`mise.toml`** — the `setup` / `verify` / `test` tasks (the container
  bridge runs `mise run setup` then `verify` per project at startup):
  `setup` = `npm ci` gated on package.json/package-lock.json vs node_modules
  staleness; `verify` = a light toolchain gate; `test` = the test suite.
- **`.pi/settings.json`** — `{}` by default. The `{"packages": [".."]}`
  self-registration is ONLY valid in the pi-task repo itself (".." is its
  package root); in a consuming project it makes pi try to load the project
  directory as an extension, which fails and breaks the session. Consuming
  projects get pi-task from user settings (or a real package path).

## Ask before environment setup

After writing the stubs, **ask the user which of these to also set up** —
each one a question, never assumed:

- `jj git init --colocate` (the ecosystem convention: jj with a colocated
  git repo) when the directory is not already a jj repo — or plain `git
  init` when the user prefers git only.
- `mise trust` (the project mise.toml runs arbitrary commands; the bridge
  runs it non-interactively at startup).
- An initial commit of the stubs once the user is happy.

Run only what the user confirms.
