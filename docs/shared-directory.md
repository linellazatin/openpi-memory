# Shared Storage Across Tools (shared_dir)

[Back to README](../README.md)

## Overview

Set `"shared_dir": true` in `memory.jsonc` to move the index and topic files to `~/.agents/memory/` — a location intended to be shared with other tools that use the same on-disk format (e.g. [openclaude-memory](https://github.com/) for opencode). `memory.jsonc` itself and `HANDOFF.md` are never affected by this setting; they always stay in pi's own agent directory.

The first time `shared_dir` resolves to `true`, if `~/.pi/agent/memory/` already has an index and `~/.agents/memory/` doesn't yet, the extension performs a one-time local carry-over: it backs up your existing index and topic files to `~/.pi/agent/memory-backup-before-shared-dir/`, then copies (never moves) them into the shared directory. Your original files in `~/.pi/agent/memory/` are never modified or deleted — the backup and the copy are both additive. This only runs once; toggling `shared_dir` off and back on later does not repeat it.

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

**If you then opt into `shared_dir: true`** by editing `memory.jsonc`, the next `getMemoryDir()` call triggers a one-time carry-over: `MEMORY.md` and your topic files (never `HANDOFF.md`, which always stays local at `~/.pi/agent/HANDOFF.md`) are backed up to `~/.pi/agent/memory-backup-before-shared-dir/`, then copied — never moved — into `~/.agents/memory/`. Your original `~/.pi/agent/memory/` directory is left fully intact:

```
~/.pi/agent/
├── memory.jsonc
├── memory-backup-before-shared-dir/      # NEW — one-time backup, no HANDOFF.md
│   ├── MEMORY.md
│   └── <topic>.md files...
└── memory/                                # untouched, still fully intact
    ├── MEMORY.md
    ├── RULES.jsonc
    ├── RULES.jsonc.bak
    └── <topic>.md files...

~/.pi/agent/HANDOFF.md                      # stays local, never migrates

~/.agents/memory/                          # NEW — active storage now
├── MEMORY.md
└── <topic>.md files...
```
