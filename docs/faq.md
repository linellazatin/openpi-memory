# Known Limitations & FAQ

[Back to README](../README.md)

## Known limitations (for now)

- Module-level injection state (`_injectedOnce`, `_turnCount`) is process-global. Safe for the standard single-user pi session; upgrade to a per-session Map if multi-session support is needed in future.
- Manual edits to `MEMORY.md` or `memory.jsonc` made between user prompts are picked up on the next `before_agent_start` call (no cache to invalidate). This is by design.
- The `/memory` browser's `[p]` hotkey tracks the focused item by mirroring `↑↓` key presses. If the SelectList's internal cursor drifts (e.g. via search filtering), `[p]` may act on a different entry than visually selected. Workaround: open the detail view with `enter` and use the action list there.

## FAQ (post-0.3.0)

Questions that came up while testing the `shared_dir` migration on an actual, already-populated install.

**Q: I just upgraded from a pre-0.3.0 version. Did anything of mine get deleted or overwritten?**
No. The config rename (`RULES.jsonc` → `memory.jsonc`) and the `shared_dir` carry-over are both strictly additive — they only ever create new files or copy existing ones. Nothing pre-existing is ever deleted, moved, or overwritten in place. See [First run: upgrading from a pre-0.3.0 install](shared-directory.md#first-run-upgrading-from-a-pre-030-install) for the exact file-by-file trace.

**Q: How do I check whether I'm currently opted in to `shared_dir`?**
Read the `shared_dir` value directly from `~/.pi/agent/memory.jsonc` — it's the only place this is configured, and it's always read fresh on every call (no caching). You can also infer it indirectly: if `~/.agents/memory/MEMORY.md` exists, `shared_dir` has been `true` at least once.

**Q: I opted in to `shared_dir`. Where did my memories go — are my old files gone?**
Your old files are untouched at `~/.pi/agent/memory/`. Opting in merges (never moves) `MEMORY.md` entries and topic files into `~/.agents/memory/`. `HANDOFF.md` is deliberately excluded — it always stays at `~/.pi/agent/HANDOFF.md`, since compaction handoff is a pi-only feature, not part of the shared cross-tool format.

**Q: I opted into `shared_dir` and another tool (e.g. openclaude-memory for opencode) already had memories in `~/.agents/memory/` — what happens to mine?**
They are merged in, not dropped. The carry-over appends any of your local entries whose topic file doesn’t already exist in the shared dir. If a filename collides with different content, your file is copied under a `-opim` suffix and that name is used in the appended index entry. If the content is identical, it’s a no-op — no duplicate is created. Nothing already in the shared dir is modified or deleted. See [Opting in when another tool already populated the shared dir](shared-directory.md#opting-in-when-another-tool-already-populated-the-shared-dir) for a full walkthrough.

**Q: If I opt in, then opt out, then opt in again — does everything stay in sync?**
**No — this is the biggest watch-out.** Toggling `shared_dir` is a one-time, one-directional migration, not a live sync:
- The carry-over from `~/.pi/agent/memory/` → `~/.agents/memory/` runs at most once, ever, guarded by a sentinel file (`~/.pi/agent/memory/.shared-dir-migrated`) written the moment the merge completes. Once that file exists, every future process start skips the merge entirely, even if you toggle `shared_dir` off and back on.
- There is **no reverse migration**. Opting out doesn't copy anything from `~/.agents/memory/` back to `~/.pi/agent/memory/` — it just changes which directory gets read/written going forward.
- This means the two directories can silently drift apart: writes made while `shared_dir: true` are invisible once you flip it back to `false`, and vice versa. Nothing is deleted, but whichever directory isn't currently active becomes a stale snapshot.

**What to do about it:** treat `shared_dir` as a deliberate one-way move, not a togglable setting you flip back and forth casually. If you do need to reconcile after toggling, diff `MEMORY.md` and the topic files between `~/.pi/agent/memory/` and `~/.agents/memory/` yourself and manually copy over whatever's missing — the extension will not do this for you.

**Q: What's `.shared-dir-migrated`, and can I delete it?**
It's an empty sentinel file the extension writes to `~/.pi/agent/memory/` the moment the `shared_dir` merge completes successfully. Its only job is to make every subsequent process start skip the merge in one `fs.existsSync` call instead of re-reading and re-comparing every local and shared file. Deleting it forces the merge to run again on the next process start — since the merge is additive and idempotent (identical content is always a no-op, collisions always resolve to the same `-opim` name), this is safe but pointless; there's no reason to delete it.

**Q: Does switching `shared_dir` also affect my `memory.jsonc` config, or my persist rules?**
No. `memory.jsonc` (config) and `HANDOFF.md` (compaction handoff) are fixed, pi-specific paths that are **never** affected by `shared_dir` — only the location of `MEMORY.md` and topic files changes. There's exactly one config file regardless of `shared_dir`'s value, so there's nothing to keep "in sync" on the config side — it's always already current.

**Q: What's `RULES.jsonc.bak` for, and can I delete it?**
It's a one-time safety backup of your legacy `RULES.jsonc`, created automatically the first time `memory.jsonc` was bootstrapped from it. It's inert afterward — nothing reads it again. Safe to keep indefinitely for peace of mind, or delete it once you've confirmed `memory.jsonc` has everything you expect.

**Q: I have two config files now (`memory.jsonc` and the old `RULES.jsonc`). Which one is active?**
`memory.jsonc` is the only one ever read after the initial migration. `~/.pi/agent/memory/RULES.jsonc` (and its `.bak`) are frozen historical snapshots from the migration moment — editing them does nothing. Always edit `~/.pi/agent/memory.jsonc`.

**Q: I edited `memory.jsonc` directly — will my changes get overwritten?**
No. `memory.jsonc` is only ever written by the extension when it doesn't exist yet (fresh install or first-time legacy fallback). Once it exists, the extension only reads it — your manual edits persist and take effect on the very next user prompt.

**Q: Does the shared directory lock/atomic-write behavior protect me from corruption if another tool writes to `~/.agents/memory/` at the same time?**
Yes, on the pi side — writes are serialized through a real filesystem advisory lock (not just an in-process mutex) and applied atomically (write-to-temp-then-rename). This protects against corruption from concurrent pi sessions, and from any other tool that also honors the same lock convention. It does **not** guarantee safety against a tool that ignores the lock file entirely and writes directly — that's a property of the other tool's implementation, not something this extension can enforce on its own.

**Q: Is the one-time `shared_dir` carry-over itself protected by that same lock?**
**No — this is a known, deliberate gap, not an oversight.** Every ordinary mutating operation (`write_memory`, `remove_memory`, `pin_memory`) acquires the cross-process lock before touching `MEMORY.md`. The one-time merge carry-over (see [Opting in when another tool already populated the shared dir](shared-directory.md#opting-in-when-another-tool-already-populated-the-shared-dir)) deliberately does not. In the narrow window where two pi processes start for the very first time with `shared_dir: true` before either has written the `.shared-dir-migrated` sentinel yet, both can pass the guard and both perform an unlocked read-modify-write on the shared `MEMORY.md` — the second writer's save can silently clobber the first writer's appended entries.

This is scoped tightly: it only matters at the literal first-ever concurrent enablement moment, never again afterward (the sentinel makes every subsequent carry-over a no-op, and every *other* operation on both sides is properly locked). If it does happen, `maintainIndex` self-heals duplicate/orphan index lines on the next ordinary write, but a clobbered append that never made it to disk at all is not recoverable automatically — you'd need to notice a missing entry and re-run `write_memory` for it. If you plan to enable `shared_dir` on two pi installations pointed at the same shared directory at the exact same time, do it one at a time rather than simultaneously to avoid this window entirely.
