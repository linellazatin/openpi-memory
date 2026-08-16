# Known Limitations & FAQ

[Back to README](../README.md)

## Known limitations

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
Your old files are untouched at `~/.pi/agent/memory/`. Opting in copies (never moves) `MEMORY.md` and topic files into `~/.agents/memory/`, and backs the originals up a second time to `~/.pi/agent/memory-backup-before-shared-dir/` before doing so. `HANDOFF.md` is deliberately excluded from both the shared dir and the backup — it always stays at `~/.pi/agent/memory/HANDOFF.md`, since compaction handoff is a pi-only feature, not part of the shared cross-tool format.

**Q: If I opt in, then opt out, then opt in again — does everything stay in sync?**
**No — this is the biggest watch-out.** Toggling `shared_dir` is a one-time, one-directional migration, not a live sync:
- The carry-over from `~/.pi/agent/memory/` → `~/.agents/memory/` only ever runs once, guarded by "does the shared `MEMORY.md` already exist." Once it's run, it never runs again, even if you toggle off and back on.
- There is **no reverse migration**. Opting out doesn't copy anything from `~/.agents/memory/` back to `~/.pi/agent/memory/` — it just changes which directory gets read/written going forward.
- This means the two directories can silently drift apart: writes made while `shared_dir: true` are invisible once you flip it back to `false`, and vice versa. Nothing is deleted, but whichever directory isn't currently active becomes a stale snapshot.

**What to do about it:** treat `shared_dir` as a deliberate one-way move, not a togglable setting you flip back and forth casually. If you do need to reconcile after toggling, diff `MEMORY.md` and the topic files between `~/.pi/agent/memory/` and `~/.agents/memory/` yourself and manually copy over whatever's missing — the extension will not do this for you.

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
