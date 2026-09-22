## What this is

`openpi-memory` is a global persistent memory extension for the [pi coding agent](https://pi.dev). It lets the agent remember what it learns across sessions, globally, inspired by Claude Code's auto-memory. It is a port of [openclaude-memory](https://github.com/linellazatin/openclaude-memory) to pi's extension API.

The package is published as `@openlines/openpi-memory`. A future migration to the [nanomneme](https://github.com/linellazatin/nanomneme) SQLite/FTS5 core is under consideration.

## Commands

```bash
npm test
# runs: node tests/core.test.mjs && node tests/extension.test.mjs

npm run typecheck
# runs: tsc --noEmit
```

## Architecture

The repository is a pi coding-agent extension. It uses flat files as the memory store, with a shared-store mode (`shared_dir`) adapted from openclaude-memory's locking and removal conventions for same-user collaboration.

Top-level layout:

- `.github/` — repository automation
- `.pi/` — pi-specific configuration
- `docs/` — documentation
- `extensions/` — extension entry points
- `skills/` — agent skills
- `tests/` — test suite (core and extension tests, plus a host-load smoke test)
- `AGENTS.md`, `README.md` / `readme.md` — agent and user documentation
- `package.json`, `package-lock.json`, `tsconfig.json` — package and TypeScript configuration
- `CHANGELOG.md`, `LICENSE`

Recent versions noted in the README:

- **v0.3.7** — pi 0.87 compatibility; hooks verified against pi 0.84.2–0.87.0 with no source changes; added host-load smoke test through pi's real loader.
- **v0.3.6** — shared-store hardening for `shared_dir`, including unsafe file handling, index collision handling, and unbo... (truncated in source).

## Testing and operational quirks

- There are two test targets: `tests/core.test.mjs` and `tests/extension.test.mjs`. Run the narrowest relevant test before the full suite when changing behavior.
- `npm test` chains both test files with `&&`, so a failure in the first stops the second.
- `tsconfig.json` is present and `typecheck` uses `tsc --noEmit`; there is no build script.
- Keep secrets and generated output out of tracked configuration.

## Key files

- `package.json` — scripts and package metadata for the npm package
- `tsconfig.json` — TypeScript configuration for `tsc --noEmit`
- `tests/core.test.mjs` — core memory behavior tests
- `tests/extension.test.mjs` — extension integration tests
- `extensions/` — extension source/entry points
- `AGENTS.md` — guidance for coding agents working in this repository
<!-- opl-init:fp 150779bf5a833b42 -->
