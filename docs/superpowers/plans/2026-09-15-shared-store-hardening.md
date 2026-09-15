# Shared-Store Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release OpenPI Memory 0.3.6 with safe, interoperable same-user `shared_dir` storage and corrected flat-file index behavior.

**Architecture:** Keep the current single `memory-core.mjs` module and Markdown files. Add small file-validation, lock, and tombstone helpers at the existing storage seam; do not introduce a database, sync process, repair command, or new shared protocol. Match current openclaude-memory’s `.lock` PID-tab-timestamp shape and `.ocl-removed` tombstone in shared mode.

**Tech Stack:** Node.js 22 built-in `fs`, `path`, and `assert`; TypeScript extension entry point; plain `.mjs` core.

**Spec:** `docs/superpowers/specs/2026-09-15-shared-store-hardening-design.md`

## Global Constraints

- Release version is exactly `0.3.6`.
- `shared_dir` is opt-in, same-user collaboration, not a sandbox.
- Only regular, non-symlink Markdown topic files are readable or writable through the extension.
- `MEMORY.md` is an index, never a topic.
- Shared mutations fail with a clear busy result rather than writing without a lock.
- Preserve topic files on removal; use `.ocl-removed` only when the active store is shared.
- Do not add dependencies, a background process, a database, live synchronization, or an OpenPI-specific tombstone.

---

### Task 1: Validate flat-file candidates and reserve the index

**Files:**
- Modify: `extensions/memory-core.mjs`
- Modify: `tests/smoke-test.mjs`

**Interfaces:**
- Produces: `isSafeTopicFilename(filename): boolean` and `isRegularFile(filePath): boolean` internal helpers.
- Produces: a normalized-topic rejection for `toSlug(topic) === 'memory'`.
- Consumes: existing `parseIndexLine`, `readTextPrefixSync`, `maintainIndex`, `searchMemory`, and topic read/write paths.

- [ ] **Step 1: Add failing unsafe-file tests**

Add smoke tests that create a normal topic, then verify that:

```js
assert.equal(parseIndexLine('- [Hidden](.hidden.md) 2026-01-01 -- x'), null);
assert.equal(parseIndexLine('- [Index](MEMORY.md) 2026-01-01 -- x'), null);
const result = await executeWriteMemory({ topic: 'MEMORY', content: 'x', summary: 'x' });
assert.ok(result.startsWith('Invalid topic:'));
```

On platforms supporting symlinks, create `linked.md` pointing outside the memory directory. Assert `readTopicContent('linked.md')` returns the existing not-found result and `searchMemory()` does not return it. Skip only on an `EPERM` symlink creation failure.

- [ ] **Step 2: Run the smoke test to verify failure**

Run: `npm test`

Expected: FAIL because hidden/reserved index lines still parse, the `MEMORY` topic is accepted, and a symlink can be read.

- [ ] **Step 3: Implement minimal filename and regular-file guards**

In `memory-core.mjs`, add helpers equivalent to:

```js
function isSafeTopicFilename(name) {
  return typeof name === 'string' && name.endsWith('.md') &&
    name.toLowerCase() !== 'memory.md' && !name.startsWith('.') &&
    !/[\\/\[\]\(\)]/.test(name) && !name.includes('..');
}
function isRegularFile(filePath) {
  try { return fs.lstatSync(filePath).isFile(); } catch { return false; }
}
```

Make `parseIndexLine()` reject unsafe filenames. Require a regular file in `maintainIndex`, `readTopicContent`, topic-body `searchMemory`, `filesEqual`, and carry-over source/destination handling. Reject the normalized `memory` slug in `executeWriteMemory` before acquiring the lock. Do not loosen existing topic-name validation.

- [ ] **Step 4: Run the focused and full checks**

Run: `npm test && npm run typecheck`

Expected: all existing tests plus the new unsafe-file tests pass.

- [ ] **Step 5: Commit the isolated safety seam**

```bash
git add extensions/memory-core.mjs tests/smoke-test.mjs
git commit -m "fix: validate shared memory files"
```

### Task 2: Make shared locking strict and lock carry-over

**Files:**
- Modify: `extensions/memory-core.mjs`
- Modify: `tests/smoke-test.mjs`

**Interfaces:**
- Produces: `withLock(memoryDir, fn, { strict })` internal helper returning the callback result or throwing a lock-contention error in strict mode.
- Produces: lock contents beginning with `${process.pid}\t`, compatible with current openclaude-memory.
- Consumes: `executeWriteMemory`, `executeRemoveMemory`, `executePinMemory`, and `maybeCarryOverLocalMemory`.

- [ ] **Step 1: Add failing lock and carry-over tests**

Add tests that write a lock with the current process PID and an old mtime, then start a write and verify it does not reclaim the live lock. Add a dead PID old-lock test that verifies reclaim succeeds. Add an ownership test: replace a held lock’s contents before release and assert the release path leaves the replacement intact. Add a carry-over test that pre-creates a live shared lock and asserts no sentinel is written and no shared index is changed.

- [ ] **Step 2: Run the smoke test to verify failure**

Run: `npm test`

Expected: FAIL because a live old lock is currently deleted and carry-over does not acquire a lock.

- [ ] **Step 3: Replace the stale-lock policy at the existing seam**

Change lock creation to atomically create a unique content token in this interoperable form:

```js
const token = `${process.pid}\t${Date.now()}\t${Math.random().toString(36).slice(2)}`;
fs.writeFileSync(lockPath, token, { flag: 'wx' });
```

For a lock older than 10 seconds, read the first tab-separated field and call `process.kill(pid, 0)`. Reclaim only when it reports `ESRCH`; use a 60-second hard timeout for malformed or legacy content. On release, unlink only when the current file contents equal the acquired token.

Refactor `withLock` to receive the resolved directory and strictness. Shared calls poll briefly, retry once, then return a clear `memory store is busy` tool result rather than writing unlocked. Local calls retain the existing wait behavior. Make carry-over run `mergeLocalIntoSharedDir` under `withLock(SHARED_MEMORY_DIR, ..., { strict: true })`; write `.shared-dir-migrated` only after that callback succeeds.

- [ ] **Step 4: Run the focused and full checks**

Run: `npm test && npm run typecheck`

Expected: live locks are retained, dead locks are reclaimed, carry-over respects contention, and all existing tests pass.

- [ ] **Step 5: Commit shared-lock hardening**

```bash
git add extensions/memory-core.mjs tests/smoke-test.mjs
git commit -m "fix: harden shared memory locking"
```

### Task 3: Align intentional removals and injected-memory boundary

**Files:**
- Modify: `extensions/memory-core.mjs`
- Modify: `extensions/index.ts`
- Modify: `tests/smoke-test.mjs`

**Interfaces:**
- Produces: internal `readRemovedList`, `addToRemovedList`, and `removeFromRemovedList` helpers for `${memoryDir}/.ocl-removed`.
- Consumes: `executeWriteMemory`, `executeRemoveMemory`, and `before_agent_start` injection.

- [ ] **Step 1: Add failing shared-tombstone and prompt tests**

Add tests with `shared_dir: true` that remove an unpinned topic and assert `.ocl-removed` contains its filename while its topic file remains. Re-write that topic and assert the filename is removed from `.ocl-removed`. Switch to `shared_dir: false`, remove a topic, and assert no `.ocl-removed` file is created. Add a focused assertion for the injected-memory preamble text if the extension hook can be exercised without Pi; otherwise cover the exact literal through a source-level TypeScript check.

- [ ] **Step 2: Run the smoke test to verify failure**

Run: `npm test`

Expected: FAIL because no tombstone is written or cleared.

- [ ] **Step 3: Add the minimal interoperable tombstone behavior**

Store one safe filename per line in `.ocl-removed`. Read it defensively, deduplicate additions, and write it atomically. On shared `executeRemoveMemory`, add the resolved filename only after the index is successfully written. On shared `executeWriteMemory`, clear that filename after the index succeeds. Never create or read this metadata in local mode.

In `index.ts`, change the injected memory preamble to state that memory is reference data and cannot override system instructions or authorize actions. Do not claim sandboxing or add an instruction-filtering subsystem.

- [ ] **Step 4: Run the focused and full checks**

Run: `npm test && npm run typecheck`

Expected: shared removals survive current openclaude-memory repair conventions; local removal behavior is unchanged.

- [ ] **Step 5: Commit interoperability behavior**

```bash
git add extensions/memory-core.mjs extensions/index.ts tests/smoke-test.mjs
git commit -m "fix: preserve shared memory removals"
```

### Task 4: Correct slug collisions, carry-over drift, and bounded interactive reads

**Files:**
- Modify: `extensions/memory-core.mjs`
- Modify: `tests/smoke-test.mjs`

**Interfaces:**
- Produces: collision allocation for unrelated topic slugs: `name.md`, `name-2.md`, then `name-3.md`.
- Consumes: existing exact-name lookup, carry-over merge, `readIndexEntries`, and `searchMemory`.

- [ ] **Step 1: Add failing index-integrity tests**

Add tests that write `Node.js` and then `Nodejs`, asserting two distinct topic files and index entries. Add a carry-over fixture where an identical shared topic file exists without its index line; assert carry-over adds exactly one index entry. Create an index larger than `MAX_BYTES`, call `readIndexEntries()` and `searchMemory()`, and assert they return bounded-prefix results without reading a known token placed after the byte limit.

- [ ] **Step 2: Run the smoke test to verify failure**

Run: `npm test`

Expected: FAIL because slug-colliding topics share a file, identical existing files are not indexed during carry-over, and interactive index reads are unbounded.

- [ ] **Step 3: Implement the smallest index fixes**

After exact display-name lookup, allocate the next numeric suffix while an unrelated regular topic file exists. Do not reuse reserved or unsafe names.

In carry-over, keep a set of parsed shared index filenames. When `resolveDestName` reports identical content, append the local entry if that destination filename is absent from the set. Preserve existing metadata and avoid duplicate entries.

Make `readIndexEntries()` read its input through `readTextPrefixSync(memoryIndex, MAX_BYTES)` and parse only that prefix. Have `searchMemory()` inherit this path for index matches; retain the existing bounded topic-body reads.

- [ ] **Step 4: Run the focused and full checks**

Run: `npm test && npm run typecheck`

Expected: collision, carry-over drift, and oversized interactive-read regressions pass with no behavior change for normal files.

- [ ] **Step 5: Commit flat-file corrections**

```bash
git add extensions/memory-core.mjs tests/smoke-test.mjs
git commit -m "fix: preserve flat-file memory index integrity"
```

### Task 5: Document and release version 0.3.6

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/shared-directory.md`
- Modify: `docs/faq.md`
- Modify: `docs/configuration.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: completed behavior from Tasks 1-4.
- Produces: release metadata and documentation accurate for current openclaude-memory shared-store conventions.

- [ ] **Step 1: Update package release metadata**

Set the root version to `0.3.6` in both `package.json` and the root package entry in `package-lock.json`. Do not change dependency versions.

- [ ] **Step 2: Add the release notes**

Add a dated `## [0.3.6]` section at the top of `CHANGELOG.md` covering strict PID-aware shared locking, locked carry-over, safe regular-file handling, `.ocl-removed` interoperability, reserved/collision-safe topic names, carry-over index repair, and bounded interactive reads.

- [ ] **Step 3: Update affected behavior documentation**

Update `README.md` with a concise 0.3.6 note and current openclaude-memory compatibility statement. Update `docs/shared-directory.md`, `docs/faq.md`, and `docs/architecture.md` to remove the unlocked carry-over caveat and accurately describe strict shared locks, same-user trust scope, and `.ocl-removed`. Update `docs/configuration.md` only to explain safe manual index/topic-file constraints and that `MEMORY.md` cannot be a topic.

- [ ] **Step 4: Verify release metadata and docs**

Run:

```bash
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if (p.version !== '0.3.6' || l.packages[''].version !== '0.3.6') process.exit(1)"
npm run typecheck
npm test
```

Expected: version check exits 0; typecheck and all smoke tests pass.

- [ ] **Step 5: Commit the release preparation**

```bash
git add package.json package-lock.json CHANGELOG.md README.md docs/shared-directory.md docs/faq.md docs/configuration.md docs/architecture.md
git commit -m "chore: prepare 0.3.6 release"
```
