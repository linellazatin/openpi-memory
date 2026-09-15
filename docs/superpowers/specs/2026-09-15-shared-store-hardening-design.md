# Shared-Store Hardening Design

## Goal

Make `shared_dir` safe for same-user collaboration with current openclaude-memory while preserving OpenPI Memory's local-first, plain-Markdown, no-service design.

## Scope and compatibility

`shared_dir` remains an opt-in same-user collaboration feature, not a sandbox against a malicious local process. The supported shared-store peer is current openclaude-memory. Its `.ocl-removed` tombstone is the compatibility convention for intentional index removals.

No database, background synchronization, protocol versioning, repair command, or new OpenPI-specific tombstone is added.

## Phase 1: shared-store security and integrity

### Safe on-disk objects

Treat filenames obtained from `MEMORY.md` and directory listings as untrusted metadata. A usable topic filename must be a non-hidden, non-reserved Markdown filename with no separators, traversal sequence, or Markdown link delimiters. `MEMORY.md` is an index only and cannot be a topic.

Before reading, maintaining, copying, or displaying an index/topic file, reject symbolic links and non-regular files. This keeps a manually corrupted shared store from exposing unrelated local files through search or previews.

### Locking

Use the common `.lock` file. Store PID and acquisition time. Reclaim an old lock only if its PID is no longer alive; retain a conservative hard timeout for malformed legacy lock contents. Release a lock only when its on-disk ownership token still matches the holder.

In `shared_dir`, lock contention must return a clear busy result rather than continue unlocked. Run the one-time carry-over merge under this same strict lock and write its sentinel only after the locked merge succeeds.

### Shared removals

When removing an entry in `shared_dir`, append its filename to `.ocl-removed`; when writing that topic again, remove the tombstone. This preserves OpenPI's non-destructive topic-file deletion policy while preventing current openclaude-memory `repair_memory` from resurrecting an intentionally removed entry.

### Prompt boundary

Keep the memory index useful but label injected shared memory as reference data. It must not override system instructions or authorize actions. This is a guardrail, not a claim that a same-user co-tenant is untrusted or sandboxed.

## Phase 2: flat-file index correctness

A new topic whose normalized slug collides with an unrelated existing file receives a numeric suffix (`-2`, `-3`, ...); an exact existing display-name match retains its filename. Reserved index names are rejected before writing.

Carry-over must append an index entry when an identical destination topic exists but is absent from the shared index. Browser and search index reads use the existing 50 KiB prefix limit instead of unbounded `readFileSync`.

## Testing

Extend `tests/smoke-test.mjs` with isolated regressions for live versus dead locks, ownership-safe release, locked carry-over, unsafe/symlinked candidates, shared tombstone interoperability, reserved `MEMORY` topics, slug collisions, carry-over index drift, and oversized browser/search index reads.

Each phase must pass `npm run typecheck` and `npm test`.

## Release: 0.3.6

This work releases as `0.3.6`. Update the root package version in both `package.json` and `package-lock.json`, then add a dated `0.3.6` changelog entry describing the shared-store hardening and flat-file fixes.

Update user-facing documentation in the same change:

- `README.md`: add the `0.3.6` release summary and state that `shared_dir` follows current openclaude-memory conventions.
- `docs/shared-directory.md`: replace the unlocked carry-over caveat with the strict-lock behavior; document same-user trust scope and `.ocl-removed` interoperability.
- `docs/faq.md`: remove the obsolete unlocked-carry-over answer; describe lock contention, supported peer conventions, and durable shared removals.
- `docs/configuration.md`: document the reserved index filename and safe-file handling only where it affects manual flat-file edits.
- `docs/architecture.md`: update the shared-store concurrency description to match PID-aware strict locking.
