# OpenPI Memory Repository Guide

## What this is

OpenPI Memory is a TypeScript/Node.js project that provides persistent memory capabilities for Pi. The repository includes the extension entry point, a shared core module, a reusable memory skill, documentation, and a smoke test.

## Commands

```sh
npm test                 # Run the smoke test
npm run typecheck        # Type-check without emitting files
```

There is no declared build or lint command. Keep changes compatible with the configured TypeScript compiler and validate behavioral changes with the smoke test.

## Architecture

- `extensions/index.ts` is the TypeScript extension entry point.
- `extensions/memory-core.mjs` contains the reusable memory core used by the extension.
- `skills/memory/SKILL.md` defines the agent-facing memory workflow.
- `tests/smoke-test.mjs` exercises the project end to end at a basic level.

Documentation describes the intended behavior and operating model, including memory injection, configuration, shared directories, and feature boundaries. Read the relevant document before changing those areas.

## Configuration and installation

Project metadata, scripts, and dependencies are defined in `package.json`; the lockfile is `package-lock.json`. TypeScript settings live in `tsconfig.json`.

Consult `README.md` for installation and usage. For configuration changes, use `docs/configuration.md`; for shared storage behavior, use `docs/shared-directory.md`.

## Testing and operational quirks

Run `npm run typecheck` and `npm test` after modifying extension or core behavior. The smoke test is the only declared test command, so do not assume a separate unit-test, build, or lint pipeline exists.

Memory behavior is documented across `docs/memory-injection.md`, `docs/architecture.md`, and `docs/faq.md`. Treat documented persistence and injection behavior as compatibility-sensitive.

## Key files

- `README.md`: installation, usage, and overview
- `CHANGELOG.md`: release history
- `docs/architecture.md`: system design
- `docs/configuration.md`: configuration reference
- `docs/features.md`: feature reference
- `.github/workflows/`: CI workflows

<!-- opl-init:fp 0312378ebfdaeffe -->