---
description: Create the standard project stubs (AGENTS.md, CONTEXT.md, docs/adr/, mise.toml, ...) for a fresh repo
argument-hint: "[repo name or details]"
---
Scaffold this new project: $@

Load the `scaffold` skill and follow it: create the standard stub files
(AGENTS.md, CONTEXT.md, docs/adr/, README.md, .gitignore, mise.toml,
`.pi/settings.json`) with minimal content, then **ask the user** whether to
also set up jj/git init, `mise trust`, and an initial commit — run only what
they confirm.
