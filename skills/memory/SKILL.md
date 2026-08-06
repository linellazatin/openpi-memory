---
name: memory
description: "Read and write global persistent memory across pi sessions"
---

# Global Memory

Global memory persists across all pi sessions. It lives at:

```
~/.pi/agent/memory/
├── MEMORY.md              # index — injected into every session automatically
├── RULES.jsonc            # persist rules + config
└── <topic>.md             # detail files — read on-demand
```

## Available tools

The extension registers three native tools. Use these instead of raw Write/Edit tools for all memory operations — they handle file format, frontmatter, and index maintenance automatically.

| Tool | Args | What it does |
|---|---|---|
| `write_memory` | `topic`, `content`, `summary`, `pin?` | Creates or appends to a topic file; upserts MEMORY.md index entry |
| `remove_memory` | `topic` | Removes the index entry (refuses if pinned); topic file preserved |
| `pin_memory` | `topic`, `pin` (bool) | Pins or unpins an index entry |

## Reading memory

`MEMORY.md` is injected into your system prompt on the first user prompt of each session, and every `inject_every_n_turns` user prompts thereafter (default: 5; set to 1 in `RULES.jsonc` for every-prompt injection).

If `## Global Memory` is not in your current context, read it directly:

```
Read ~/.pi/agent/memory/MEMORY.md
```

## Writing memory

Always use `write_memory` — never edit `MEMORY.md` or topic files directly. The tool:
- Creates a topic file with YAML frontmatter on first write
- On subsequent writes: appends under a `## YYYY-MM-DD` heading (default) or replaces the full body (`overwrite: true`)
- Upserts the `MEMORY.md` index entry with the correct date and summary
- Runs index maintenance (orphan removal, deduplication, stale stamping) after every write

**When to use `overwrite: true`:** the topic holds a current state that should be replaced — hardware specs, environment config, a tool version, user preferences. Passing the updated full spec with `overwrite: true` replaces the body and updates `last_updated` in the frontmatter.

**When to use the default (append):** the topic is a log of discoveries, fixes, or incremental notes — each entry should be preserved with its date. Pass only the new fact or delta as `content`, not a full rewrite of existing content.

## When to write

Follow the persist rules injected under `## Memory Rules`. When in doubt:
- **Write** anything you had to look up, figure out, or that took effort to discover
- **Write** any config, command, or environment fact that will apply to future sessions
- **Don't write** things that are only relevant to this session
- **Ask first** before writing credentials, personal data, or anything the user marks private

## Index format

Each entry in `MEMORY.md` follows this format:

```
- [Topic Name](filename.md) [pin] YYYY-MM-DD [stale?] -- one-line summary
```

- `[pin]` — entry will never be a removal candidate and never flagged as stale
- `[stale?]` — entry has not been updated in over `stale_after_days` days (default: 180)
- Both tokens are optional; dates and filenames are managed by the extension

## Stale entries

The extension stamps `[stale?]` on index entries older than `stale_after_days` (default 180, configurable in `RULES.jsonc`). The flag appears in the index line after the date:

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

If the injected `## Global Memory` block contains a truncation warning (`memory truncated`), the index has exceeded the configured line limit and must be trimmed. Steps:

1. Read `MEMORY.md` in full to assess all entries.
2. Identify candidates for removal in this order:
   - **Skip immediately**: any entry with `[pin]` — never a removal candidate
   - **Remove without judgment**: entry points to a file that no longer exists; or two entries share a filename (keep the more recent date, remove the other). Use `remove_memory` for these.
   - **Remove only if clearly obsolete**: topic was session-specific and no longer applies; topic is fully superseded by a newer broader entry. When in doubt, keep it. Use `remove_memory`.
   - **`[stale?]` entries**: review first — highest priority candidates.
3. If all entries are still valid but the count is high, consolidate: merge two closely related topic files into one via `write_memory`, then `remove_memory` the redundant entry.
4. Topic file content is never deleted — only index lines are removed.
5. Re-read `MEMORY.md` after trimming to confirm it is under the configured limit.

## Persist rules

Your persist rules are in `~/.pi/agent/memory/RULES.jsonc` and are injected into your context under `## Memory Rules` on the first prompt of each session and every `inject_every_n_turns` prompts thereafter.

If no `## Memory Rules` block is in your context, read `~/.pi/agent/memory/RULES.jsonc` directly.

## Editing RULES.jsonc

`RULES.jsonc` is a JSON file with comment support (`//` line comments are valid). Example:

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
    "Session-specific context that won't apply to future sessions",
    "Assumed or inferred preferences — only persist what the user has explicitly stated",
    "Large blocks of code — summarize instead, or link to the file path"
  ],
  "always_ask": [
    "Credentials, tokens, API keys",
    "Personal data",
    "Anything the user marks as private or ephemeral"
  ],
  // max_lines: valid range 50–500
  "max_lines": 200,
  // stale_after_days: 0 = disable age flagging
  "stale_after_days": 180,
  // inject_every_n_turns: 1 = inject on every user prompt
  "inject_every_n_turns": 5
}
```

Config scalars are consumed by the extension and never injected into the system prompt. Changes take effect on the next user prompt — no reload required.
