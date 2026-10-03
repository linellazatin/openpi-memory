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

- **v0.3.9** — shared-store coordination with openclaude-memory; read-only missing-index reads, locked async recap retirement, directory-pinned mutations, bounded local contention, no-follow/bounded reads, per-file rollback, refreshed frontmatter metadata, and exclusive config publication. Verified against pi 0.99.1 and pi 1.0.0 (API additions only) with no source changes.
- **v0.3.8** — pi 0.99 re-assessment; verified against pi 0.87.0–0.99.1 with no source changes; supported floor raised to `>=0.87.0` and `engines.node` to `>=22.19.0`; host-load smoke test gained a built-in name-collision guard (skipped below pi 0.99).
- **v0.3.7** — pi 0.87 compatibility; hooks verified against pi 0.84.2–0.87.0 with no source changes; added host-load smoke test through pi's real loader.
- **v0.3.6** — shared-store hardening for `shared_dir`, including unsafe file handling, index collision handling, and unbo... (truncated in source).

## Testing and operational quirks

- Missing-index reads stay in memory. Startup recap retirement is async and locked; await it before session-start processing finishes.
- Mutations retain the acquired directory across config changes. Local contention refuses after about 500 ms; shared mode waits about 2 s and retries once after 1 s. Never bypass a busy lock.
- Carry-over locks local then shared and respects both removal lists. Shared removal intent is recorded before deleting discoverability. New topics preserve unrelated unindexed slug owners.
- Reads verify no-follow regular-file descriptors; previews/search are bounded after opening. Atomic writes flush/clean temporary files, and ordinary write failures attempt rollback. Do not claim multi-file crash atomicity or atomic compare-and-unlink leases.
- Current baseline: 134 core checks, 12 real pi-loader checks, and typecheck on pi 0.99.1 and pi 1.0.0. OpenCode's optional real-process shared-writer check also exercises this core. Its per-request injection differs from pi's unchanged scheduled injection.

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
