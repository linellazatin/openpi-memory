---
name: memory
description: "Read and write global persistent memory across pi sessions"
---

# Global Memory

Global memory persists across all pi sessions. It lives at:

```
~/.pi/agent/memory/          # or ~/.agents/memory/ if shared_dir: true
├── MEMORY.md              # index — injected into every session automatically
└── <topic>.md             # detail files — read on-demand

~/.pi/agent/memory.jsonc    # persist rules + config — always per-tool, never shared
~/.pi/agent/HANDOFF.md      # compaction handoff entries (auto-managed, always local)
```

## Available tools

The extension registers three native tools. Use these instead of raw Write/Edit tools for all memory operations — they handle file format, frontmatter, and index maintenance automatically.

| Tool | Args | What it does |
|---|---|---|
| `write_memory` | `topic`, `content`, `summary`, `pin?`, `mode?` | Creates or appends/replaces a topic file; upserts MEMORY.md index entry |
| `remove_memory` | `topic` | Removes the index entry (refuses if pinned); topic file preserved |
| `pin_memory` | `topic`, `pin` (bool) | Pins or unpins an index entry |

## Reading memory

`MEMORY.md` is injected into your system prompt on the first user prompt of each session, and every `inject_every_n_turns` user prompts thereafter (default: 5; set to 1 in `memory.jsonc` for every-prompt injection).

If `## Global Memory` is not in your current context, read it directly (path depends on `shared_dir` — see "## Memory Rules" injected context or `memory.jsonc` for the active location):

```
Read ~/.pi/agent/memory/MEMORY.md
```

## Memory Types

When calling `write_memory`, assign the topic to one of four categories. Types are an organizing convention — the plugin does not enforce them and does not write a `type:` frontmatter field automatically.

| Type | What it stores | When to save | Body structure |
|---|---|---|---|
| `user` | Who the user is: role, expertise, preferences, tools, goals | When you learn something about the user that should change how you work with them in future sessions | Plain prose |
| `feedback` | How to approach work — corrections AND validated approaches | When corrected ("don't do X") OR when something non-obvious works well ("yes, keep doing that") | Rule → **Why:** → **How to apply:** |
| `project` | Ongoing work, decisions, constraints, deadlines | When you learn a non-obvious constraint, decision, or stakeholder requirement | Fact → **Why:** → **How to apply:** |
| `reference` | Pointers to external systems | When you learn where information lives (repos, boards, dashboards, channels, issue trackers) | Plain prose |

For `feedback` and `project` types, structure the body like this:

```
Rule or fact statement.

**Why:** The incident or preference that prompted this.
**How to apply:** When it kicks in and edge-case guidance.
```

## When to save

Save **proactively** — without being asked — when you learn any of the following mid-session:

- Something about the user that should change how you work with them in future sessions (`user` type)
- An approach was corrected or a non-obvious approach was confirmed (`feedback` type)
- A non-obvious project constraint, decision, or deadline emerged (`project` type)
- You learned where something lives in an external system (`reference` type)

Do not save:
- Code patterns derivable from the codebase or git history
- Debugging fix recipes (the fix is in the commit, not in memory)
- Ephemeral task state that won't apply next session
- Things already documented in `AGENTS.md` / `CLAUDE.md`
- Large code blocks — summarize or link to the file path instead

## Writing memory

Always use `write_memory` — never edit `MEMORY.md` or topic files directly. Topics must be non-empty, produce a filename slug, and cannot contain newlines or Markdown link delimiters (`[`, `]`, `(`, `)`). Summaries are normalized to one line and capped at 500 characters. The tool:
- Creates a topic file with YAML frontmatter on first write
- On subsequent writes: appends under a dated heading (`mode: "append"`, default) or replaces the full body (`mode: "replace"`)
- Upserts the `MEMORY.md` index entry with the correct date and summary
- Runs index maintenance (orphan removal, deduplication, stale stamping) after every write

**`mode: "replace"`** — the topic holds a current state that should be replaced: hardware specs, environment config, a tool version, user preferences. Replaces the body and updates `last_updated` in frontmatter. No dated heading added.

**`mode: "append"` (default)** — the topic is a log of discoveries, fixes, or incremental notes. Pass only the new fact or delta as `content`. Each entry is preserved with its date.

**Pin-preservation**: passing `pin: false` to `write_memory` on an already-pinned entry does NOT unpin it — the existing `[pin]` is preserved. Use `pin_memory({ topic, pin: false })` to explicitly unpin.

## Freshness verification

Before acting on anything named in a memory — a file path, function name, config flag, or external URL — verify it still exists:

- **File path** → `Read` or `Glob` to confirm the file is there
- **Function or symbol** → `grep` for the name in the codebase
- **Config key or flag** → check the relevant config file

A memory that names a specific file or function is a claim made when it was written. It may have been renamed, removed, or never merged. Trust what you observe now over what the memory says. If the named thing is gone, update or remove the memory.

## Cross-linking

In a topic file body, use `[[slug]]` to reference a related memory:

```
See also: [[postgresql-setup]], [[homelab-hardware-specs]]
```

Where `slug` is the topic's filename without `.md`. A `[[slug]]` that doesn't match an existing file yet is valid — it marks something worth writing later.

## Index format

Each entry in `MEMORY.md` follows this format:

```
- [Topic Name](filename.md) [pin] YYYY-MM-DD [stale?] -- one-line summary
```

- `[pin]` — entry will never be a removal candidate and never flagged as stale
- `[stale?]` — entry has not been updated in over `stale_after_days` days (default: 180)
- Both tokens are optional; dates and filenames are managed by the extension

## Stale entries

The extension stamps `[stale?]` on index entries older than `stale_after_days` (default 180, configurable in `memory.jsonc`). The flag appears in the index line after the date:

```
- [Topic Name](file.md) 2025-11-01 [stale?] -- summary
```

`[stale?]` is a candidate signal, not a deletion order.

**Self-healing**: when you call `write_memory` on a stale topic, the extension updates the date and removes `[stale?]` automatically during the next index maintenance pass.

**Pinned entries are never flagged** regardless of age.

**Entries with no date** are never flagged — treated as legacy entries.

When you see `[stale?]` entries:
- Ask the user if the topic is still relevant
- Call `write_memory` to refresh it (flag disappears automatically)
- Call `remove_memory` to delete the index entry if clearly obsolete

## When the cap is hit

If the injected `## Global Memory` block contains a truncation warning (`memory truncated`), the index has exceeded the configured line limit (default: 300 lines) or the 50 KB hard byte cap and must be trimmed. The extension reads only the first 50 KB of an oversized index; topic previews and body searches use the same 50 KB ceiling. Steps:

1. Read `MEMORY.md` in full to assess all entries.
2. Identify candidates for removal in this order:
   - **Skip immediately**: any entry with `[pin]` — never a removal candidate
   - **Remove without judgment**: entry points to a file that no longer exists; or two entries share a filename (keep the more recent date, remove the other). Use `remove_memory` for these.
   - **Remove only if clearly obsolete**: topic was session-specific and no longer applies; topic is fully superseded by a newer broader entry. When in doubt, keep it. Use `remove_memory`.
   - **`[stale?]` entries**: review first — highest priority candidates.
3. If all entries are still valid but the count is high, consolidate: merge two closely related topic files into one via `write_memory`, then `remove_memory` the redundant entry.
4. Topic file content is never deleted — only index lines are removed.
5. Re-read `MEMORY.md` after trimming to confirm it is under the configured limit.

## TUI browser

The `/memory` command provides an interactive TUI browser. From it you can:
- Navigate entries with arrow keys
- Press `enter` to view topic content (capped at 6 preview lines)
- Press `[p]` to pin/unpin
- Press `[r]` to remove (with confirmation)
- Press `esc` to exit

`/memory search <query>` opens the same browser pre-filtered to matching entries.

`/memory consolidate` instructs the agent to scan the current conversation and call `write_memory` for each undocumented fact, decision, discovery, or config detail that belongs in memory under your current `memory.jsonc` rules. Use at natural session breakpoints or before switching context. Enable `consolidate_on_compact: true` in `memory.jsonc` to run this automatically after threshold compaction; that path also stores pi's compaction summary as the next `HANDOFF.md` orientation entry.

## Persist rules

Your persist rules are in `~/.pi/agent/memory.jsonc` and are injected into your context under `## Memory Rules` on the first prompt of each session and every `inject_every_n_turns` prompts thereafter.

If no `## Memory Rules` block is in your context, read `~/.pi/agent/memory.jsonc` directly.

## Editing memory.jsonc

`memory.jsonc` is a JSON file with comment support (`//` line comments are valid). If upgrading from an older version, the legacy `~/.pi/agent/memory/RULES.jsonc` is read as a fallback, backed up to `RULES.jsonc.bak` alongside it, and copied forward automatically — nothing legacy is deleted or moved. Example:

```jsonc
{
  // What to always persist
  "always_persist": [
    "Any issue solved or fixed",
    "User preferences explicitly stated by the user",
    "Server or infrastructure configuration discovered or changed",
    "Reusable commands or workflows identified",
    "Hardware, model, or environment facts learned"
  ],
  "never_persist": [
    "Code patterns derivable from the codebase or git history",
    "Debugging fix recipes — the fix is in the commit, not in memory",
    "Ephemeral task state that won't apply next session",
    "Things already documented in AGENTS.md or CLAUDE.md",
    "Large code blocks — summarize or link to the file path instead"
  ],
  "always_ask": [
    "Credentials, tokens, API keys",
    "Personal data",
    "Anything the user marks as private or ephemeral"
  ],
  // max_lines: valid range 50–1000
  "max_lines": 300,
  // stale_after_days: 0 = disable age flagging
  "stale_after_days": 180,
  // inject_every_n_turns: 1 = inject on every user prompt
  "inject_every_n_turns": 5,
  // handoff_keep: number of compaction handoff entries to retain; 0 = disable
  "handoff_keep": 3,
  // auto_resume_after_threshold_compaction: send "Continue." after threshold compaction
  "auto_resume_after_threshold_compaction": false,
  // consolidate_on_compact: run /memory consolidate after threshold compaction; false = off
  "consolidate_on_compact": false,
  // shared_dir: redirect the memory index and topic files to ~/.agents/memory/, shared across
  // tools using the same on-disk format. Does not affect where this config file lives. false = off
  "shared_dir": false
}
```

Config scalars are consumed by the extension and never injected into the system prompt. Changes take effect on the next user prompt — no reload required.
