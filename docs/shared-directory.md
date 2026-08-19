# Shared Storage Across Tools (shared_dir)

[Back to README](../README.md)

## Overview

Set `"shared_dir": true` in `memory.jsonc` to move the index and topic files to `~/.agents/memory/` — a location intended to be shared with other tools that use the same on-disk format (e.g. [openclaude-memory](https://github.com/) for opencode). `memory.jsonc` itself and `HANDOFF.md` are never affected by this setting; they always stay in pi's own agent directory.

The first time `shared_dir` resolves to `true`, the extension performs a one-time merge carry-over from `~/.pi/agent/memory/` into `~/.agents/memory/`. Unlike a simple copy, **the merge is safe even if another tool has already written to the shared directory**: local entries whose topic file is absent in the shared dir are appended to the shared `MEMORY.md` and their files are copied in. If a local filename collides with a pre-existing shared file of *different* content, the local file is copied under a `-opim` suffix (e.g. `docker-setup-opim.md`) and the shared index gains a corresponding entry. If the content is identical, it is a no-op — no duplicate file or entry is created. Files already present in the shared dir are never modified or deleted.

This merge runs at most once, ever — not once per process. Completion is marked by an empty sentinel file, `~/.pi/agent/memory/.shared-dir-migrated`, written only after a successful merge. Every process start after that checks for the sentinel first: if present, the whole merge (index read, directory listing, per-entry content comparisons) is skipped entirely — a single `fs.existsSync` call instead of reading every local and shared file. Toggling `shared_dir` off and back on later does not repeat the merge, sentinel or not.

Cross-process writes to the shared directory are protected by a real filesystem lock (not just an in-process mutex), and index/topic-file writes are atomic (write-to-temp then rename), so a pi session and another tool's session can safely write to the same shared directory without corrupting it.

## First run: fresh install

On a brand-new install, nothing exists on disk yet. Here's exactly what happens, in order:

1. **Extension loads.** Hooks and tools register. No filesystem I/O happens yet.
2. **`session_start` fires.** `parseRules()` runs first: `~/.pi/agent/memory.jsonc` doesn't exist and neither does a legacy `RULES.jsonc`, so it writes fresh defaults to `~/.pi/agent/memory.jsonc`. Then `readMemoryIndex()` runs: it resolves the memory dir (`shared_dir` defaults to `false`, so `~/.pi/agent/memory/`), creates that directory, and writes an empty `MEMORY.md` (`# Memory Index`).
3. **You send your first prompt.** `before_agent_start` fires: it reads back the (empty) index and the rendered rules, and injects `## Global Memory` and `## Memory Rules` into the system prompt. No `HANDOFF.md` exists yet, so no `## Compaction Handoff` block is added.

Resulting state:

```
~/.pi/agent/
├── memory.jsonc          # fresh defaults
└── memory/
    └── MEMORY.md          # "# Memory Index" — empty, no entries yet
```

The agent's first turn sees the empty index and your (default) persist rules, ready to start calling `write_memory`.

## First run: upgrading from a pre-0.3.0 install

If you already have memories and a config from before 0.3.0, nothing you have is touched destructively — the upgrade only adds files.

Starting state:

```
~/.pi/agent/memory/
├── MEMORY.md              # your real entries
├── RULES.jsonc            # your custom config
└── <topic>.md files...

~/.pi/agent/HANDOFF.md     # if a compaction happened recently (always local)
```

1. **`session_start` fires.** `parseRules()` finds no `~/.pi/agent/memory.jsonc`, but finds your legacy `~/.pi/agent/memory/RULES.jsonc`. It backs that up to `RULES.jsonc.bak` (one-time — skipped on future runs) and copies its content forward into the new `memory.jsonc`. Your original `RULES.jsonc` is never deleted, moved, or modified. `readMemoryIndex()` then resolves the memory dir — still `~/.pi/agent/memory/`, since `shared_dir` isn't in your old config and defaults to `false` — and finds your real `MEMORY.md` already there, so it just reads it back untouched.
2. **Your first prompt after upgrading.** Injection works exactly as before: your real index, your custom rules, and (if present) your existing `HANDOFF.md` entry are all injected, unchanged.

Resulting state — two new files added, nothing removed:

```
~/.pi/agent/
├── memory.jsonc            # NEW — copy of your old config
└── memory/
    ├── MEMORY.md            # unchanged
    ├── RULES.jsonc           # unchanged, now inert
    ├── RULES.jsonc.bak       # NEW — safety backup
    └── <topic>.md files...   # unchanged

~/.pi/agent/HANDOFF.md      # unchanged — always local, never in memory/
```

Net effect: the agent's first turn after upgrading behaves exactly as it did before. Your memory content, rules, and handoff behavior are all preserved as-is.

**If you then opt into `shared_dir: true`** by editing `memory.jsonc`, the next `getMemoryDir()` call triggers a one-time merge carry-over: `MEMORY.md` entries and topic files are merged into `~/.agents/memory/` (never moved). A sentinel file is dropped into your original legacy dir to mark the merge complete; nothing else there is touched:

```
~/.pi/agent/
├── memory.jsonc
└── memory/                                # untouched, still fully intact
    ├── MEMORY.md
    ├── RULES.jsonc
    ├── RULES.jsonc.bak
    ├── .shared-dir-migrated                # NEW — empty sentinel, marks merge done
    └── <topic>.md files...

~/.pi/agent/HANDOFF.md                      # stays local, never migrates

~/.agents/memory/                          # NEW — active storage now
├── MEMORY.md                              # merged from local
└── <topic>.md files...
```

## Opting in when another tool already populated the shared dir

If you opt into `shared_dir` for openpi-memory *after* another tool (e.g. openclaude-memory for opencode) has already populated `~/.agents/memory/`, the merge carry-over handles it safely:

- **No collision**: your local topic file doesn't exist in the shared dir yet — it is copied in and its entry is appended to the shared `MEMORY.md`.
- **Identical-content collision**: the same file exists in the shared dir with byte-identical content — nothing is copied or appended (already there).
- **Differing-content collision**: the same filename exists in the shared dir but with different content — your local file is copied as `<name>-opim.md` and that filename is used in the appended index entry. The existing shared file and its entry are untouched.

Example: you have `docker-setup.md` locally; the shared dir already has a `docker-setup.md` from opencode with different content. After carry-over:

```
~/.agents/memory/
├── MEMORY.md          # contains both the original entry AND a new entry for docker-setup-opim.md
├── docker-setup.md    # opencode's original — untouched
└── docker-setup-opim.md  # your pi content — merged in under the -opim suffix
```

The `-opim` suffix is stable and permanent: it's decided once, during the single merge run, and then locked in by the sentinel file. Restarting pi does **not** re-run the collision check — the sentinel at `~/.pi/agent/memory/.shared-dir-migrated` short-circuits the merge before it ever reaches `docker-setup-opim.md` again.
