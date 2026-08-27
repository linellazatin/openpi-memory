# Configuration & Index Reference

[Back to README](../README.md)

## Index format

Each line in `MEMORY.md` follows this format:

```
- [Topic Name](filename.md) [pin] YYYY-MM-DDTHH:MM:SS±HH:MM [stale?] -- one-line summary
```

The date stamp is a full ISO 8601 datetime with the host timezone offset (e.g. `2026-08-07T01:15:30+08:00`). Legacy entries with date-only stamps (`YYYY-MM-DD`) remain readable — the extension handles both formats.

- `[pin]` — pinned entries are never cleanup candidates and never flagged stale
- `[stale?]` — entry has not been updated in over `stale_after_days` days
- Both tokens are optional and managed by the extension

`write_memory` requires a non-empty topic that produces a filename slug; topic names cannot contain newlines or Markdown link delimiters (`[`, `]`, `(`, `)`). Its `summary` is normalized to one line and capped at 500 characters before it is written to this index.

## Stale flagging

The extension stamps `[stale?]` on index entries older than `stale_after_days` (default 180). This happens during index maintenance after any write, not on read. The flag self-heals: calling `write_memory` on a stale topic removes it automatically.

Pinned entries are never flagged. Entries with no date are never flagged.

Set `"stale_after_days": 0` to disable age flagging entirely.

## Index maintenance

After every `write_memory`, `remove_memory`, or `pin_memory` call, the extension runs a maintenance pass on `MEMORY.md`:

- **Orphan removal** — removes entries whose topic file no longer exists on disk
- **Deduplication** — keeps the entry with the newer date if two entries share a filename
- **Stale stamping/healing** — applies or removes `[stale?]` based on entry age

Maintenance never runs on read — only on write. The on-disk `MEMORY.md` has no hard entry cap — `maintainIndex` never prunes valid entries. Only `readMemoryIndex` truncates what gets injected (line cap + 50 KB byte cap). Manual trimming via `/memory remove` or the browser is the remediation path when the index grows large.

## memory.jsonc

`~/.pi/agent/memory.jsonc` is created with defaults on first run. It is a JSON file with comment support (`//` line comments are valid). If you're upgrading from an older version, the legacy `~/.pi/agent/memory/RULES.jsonc` is read as a fallback, backed up to `RULES.jsonc.bak` alongside it, and copied forward automatically — the legacy file itself is never deleted or moved.

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
  // What to never persist
  "never_persist": [
    "Code patterns derivable from the codebase or git history",
    "Debugging fix recipes — the fix is in the commit, not in memory",
    "Ephemeral task state that won't apply next session",
    "Things already documented in AGENTS.md or CLAUDE.md",
    "Large code blocks — summarize or link to the file path instead"
  ],
  // Always ask before persisting these
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
  // handoff_keep: number of compaction handoff entries to retain in HANDOFF.md; 0 = disable
  "handoff_keep": 3,
  // auto_resume_after_threshold_compaction: send "Continue." after threshold compaction; false = off
  "auto_resume_after_threshold_compaction": false,
  // consolidate_on_compact: run /memory consolidate after threshold compaction instead of plain "Continue."; false = off
  "consolidate_on_compact": false,
  // shared_dir: redirect the memory index and topic files to ~/.agents/memory/, shared across tools
  // that use the same on-disk format. Does not affect where this config file itself lives. false = off
  "shared_dir": false
}
```

The rule arrays (`always_persist`, `never_persist`, `always_ask`) are rendered to markdown and injected into the system prompt. Config scalars (`max_lines`, `stale_after_days`, `inject_every_n_turns`, `handoff_keep`, `auto_resume_after_threshold_compaction`, `consolidate_on_compact`, `shared_dir`) are consumed by the extension and never injected. Changes take effect on the next user prompt — no reload required.
