# Changelog

All notable changes to this project will be documented in this file.

## [0.0.3] - 2026-08-08

### Added

- **Compaction handoff** — on `session_before_compact`, the last assistant messages before the context cut are extracted, converted to terse bullet points, and appended to `HANDOFF.md`. The most recent entry is injected into the system prompt after MEMORY.md so the agent can resume in-flight work without the user re-explaining. Configurable via `handoff_keep` in `RULES.jsonc` (default: 3 entries retained; 0 disables).
- **`/memory search <query>`** — case-insensitive substring search across the memory index (name, filename, summary) and all topic file bodies. Results open in the full interactive browser (same pin/unpin, remove, detail view as `/memory`) filtered to matching entries.

### Changed

- **Full box border on all overlays** — replaced bare horizontal rules with complete Unicode box drawing (`┌─┐` / `│ │` / `└─┘`)
- **Detail view: 6-line content preview** — truncated body shows `… N more lines (filename.md)`; keeps actions always visible
- **Detail view: title capped at 6 words** — long topic names are shortened with `…`
- **List view: selection position persisted** — highlight survives detail view, pin/unpin, and remove; removal moves cursor to the next entry

## [0.0.2] - 2026-08-08
(RE-PACKAGED) Initial port of [openclaude-memory](https://github.com/linellazatin/openclaude-memory) from opencode to pi coding agent.

### What's included (for pi)

- `write_memory`, `remove_memory`, `pin_memory` tools registered via `pi.registerTool()` with typebox schemas (replaces opencode's `tool` hook + zod)
- `before_agent_start` hook injects `MEMORY.md` + rendered rules into the system prompt once per user prompt, throttled by `inject_every_n_turns` (default: 5)
- `session_before_compact` hook resets injection state so the first prompt after compaction always re-injects
- `/memory` command registered via `pi.registerCommand()` with four branches: show index, store, pin/unpin, remove
- `skills/memory/SKILL.md` with pi Agent Skills frontmatter
- `RULES.jsonc` replaces `RULES.md` — structured JSON with `//` comment support; rule arrays rendered to markdown at injection time (no token overhead vs the old markdown file)
- Storage path: `~/.pi/agent/memory/` (respects `PI_CODING_AGENT_DIR`)
- 34 smoke tests, zero framework, plain `node test.mjs`

### Added (for pi)

- **`overwrite` parameter on `write_memory`** — `overwrite: true` replaces the full topic body in-place (frontmatter preserved, `last_updated` refreshed). Use for state entries like hardware specs, config, and user preferences. Default (`false`) appends under a `## YYYY-MM-DD` date heading as before.
- **Interactive `/memory` browser** — `/memory` with no args now opens a navigable overlay instead of a plain-text table:
  - List view: all topics with date and pin/stale status; `↑↓` to navigate, `enter` to open detail, `p` to pin/unpin in-place, `esc` to exit
  - Detail view: full Markdown-rendered topic body, metadata (summary, date, pin/stale), and action list (Pin/Unpin, Remove, Back); `p` hotkey for pin/unpin; any action or `esc` returns to the list
- **`last_updated` in topic frontmatter** — every topic file now tracks both `created` and `last_updated`, both as full ISO 8601 datetime strings with host timezone offset (e.g. `2026-08-07T01:15:30+08:00`)
- **Full datetime in index entries** — `MEMORY.md` index stamps use the same full ISO 8601 format; old date-only entries remain readable (the stale regex handles both formats)
- **`promptSnippet` and `promptGuidelines` on `write_memory`** — the tool now appears in pi's "Available tools" section every turn and carries two guideline bullets in the "Guidelines" section, independent of `inject_every_n_turns`. This closes the gap where the model had no reminder to persist on turns between injections
- **`session_start` hook** — bootstraps `~/.pi/agent/memory/` directory, `MEMORY.md`, and `RULES.jsonc` on extension load; also resets injection state (`_injectedOnce`, `_turnCount`) for clean per-session behavior. Previously files were only created on the first user prompt, making upfront customisation of `RULES.jsonc` impossible
- **`readIndexEntries()`** — exported helper that returns structured entry objects `{name, filename, date, summary, pinned, stale}` for UI and other consumers
- **`readTopicContent(filename)`** — exported helper that reads a topic file with frontmatter stripped, used by the detail view
- **`updateFrontmatterLastUpdated()`** — exported helper that updates or inserts `last_updated` in YAML frontmatter

## [0.0.1] - 2026-08-06

Initial port of [openclaude-memory](https://github.com/linellazatin/openclaude-memory) from opencode to pi coding agent.

### What's included (for pi)

- `write_memory`, `remove_memory`, `pin_memory` tools registered via `pi.registerTool()` with typebox schemas (replaces opencode's `tool` hook + zod)
- `before_agent_start` hook injects `MEMORY.md` + rendered rules into the system prompt once per user prompt, throttled by `inject_every_n_turns` (default: 5)
- `session_before_compact` hook resets injection state so the first prompt after compaction always re-injects
- `/memory` command registered via `pi.registerCommand()` with four branches: show index, store, pin/unpin, remove
- `skills/memory/SKILL.md` with pi Agent Skills frontmatter
- `RULES.jsonc` replaces `RULES.md` — structured JSON with `//` comment support; rule arrays rendered to markdown at injection time (no token overhead vs the old markdown file)
- Storage path: `~/.pi/agent/memory/` (respects `PI_CODING_AGENT_DIR`)
- 34 smoke tests, zero framework, plain `node test.mjs`

### Added (for pi)

- **`overwrite` parameter on `write_memory`** — `overwrite: true` replaces the full topic body in-place (frontmatter preserved, `last_updated` refreshed). Use for state entries like hardware specs, config, and user preferences. Default (`false`) appends under a `## YYYY-MM-DD` date heading as before.
- **Interactive `/memory` browser** — `/memory` with no args now opens a navigable overlay instead of a plain-text table:
  - List view: all topics with date and pin/stale status; `↑↓` to navigate, `enter` to open detail, `p` to pin/unpin in-place, `esc` to exit
  - Detail view: full Markdown-rendered topic body, metadata (summary, date, pin/stale), and action list (Pin/Unpin, Remove, Back); `p` hotkey for pin/unpin; any action or `esc` returns to the list
- **`last_updated` in topic frontmatter** — every topic file now tracks both `created` and `last_updated`, both as full ISO 8601 datetime strings with host timezone offset (e.g. `2026-08-07T01:15:30+08:00`)
- **Full datetime in index entries** — `MEMORY.md` index stamps use the same full ISO 8601 format; old date-only entries remain readable (the stale regex handles both formats)
- **`promptSnippet` and `promptGuidelines` on `write_memory`** — the tool now appears in pi's "Available tools" section every turn and carries two guideline bullets in the "Guidelines" section, independent of `inject_every_n_turns`. This closes the gap where the model had no reminder to persist on turns between injections
- **`session_start` hook** — bootstraps `~/.pi/agent/memory/` directory, `MEMORY.md`, and `RULES.jsonc` on extension load; also resets injection state (`_injectedOnce`, `_turnCount`) for clean per-session behavior. Previously files were only created on the first user prompt, making upfront customisation of `RULES.jsonc` impossible
- **`readIndexEntries()`** — exported helper that returns structured entry objects `{name, filename, date, summary, pinned, stale}` for UI and other consumers
- **`readTopicContent(filename)`** — exported helper that reads a topic file with frontmatter stripped, used by the detail view
- **`updateFrontmatterLastUpdated()`** — exported helper that updates or inserts `last_updated` in YAML frontmatter
