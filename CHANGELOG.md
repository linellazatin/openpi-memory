# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-08-16

### Added
- `/memory consolidate` command — sends a structured prompt to the agent to scan the conversation and call `write_memory` for each undocumented fact, decision, discovery, or config detail; also writes a `last-session-recap` entry for next-session orientation
- `CONSOLIDATION_PROMPT` constant in `memory-core.mjs` — used by the manual `/memory consolidate` path (full conversation scan)
- `buildCompactionConsolidationPrompt(summary)` function in `memory-core.mjs` — targeted prompt that feeds pi's compaction summary directly, skipping the full conversation scan
- `session_compact` hook to capture `event.compactionEntry.summary` for use by `compaction_end`
- `consolidate_on_compact` RULES.jsonc config key (boolean, default `false`) — when enabled, fires after threshold compaction instead of the plain `"Continue."` nudge; uses the compaction summary as input
- `last-session-recap` memory topic — a replace-mode entry written as the final step of consolidation; injected on the next session start as part of the normal `## Global Memory` block

### Changed
- `MAX_BYTES` increased from 25 KB to 50 KB — needed headroom for indexes that grow through repeated consolidation sessions
- Default `max_lines` increased from 200 to 300 — more realistic baseline for consolidated usage
- `max_lines` valid range ceiling raised from 500 to 1000 — power users can configure larger indexes
- `compaction_end` handler now checks `consolidateOnCompact` before existing auto-resume paths; `consolidate_on_compact: true` supersedes both `auto_resume_after_threshold_compaction` and handoff-aware detection
- `consolidate_on_compact` path feeds pi's already-generated compaction summary to the agent instead of asking it to re-scan conversation history — one fewer LLM turn; falls back to full scan if no summary is cached

## [0.1.0] - 2026-08-13

### Added

- **Memory Types taxonomy** in `SKILL.md` — 4-type organizing convention (`user`, `feedback`, `project`, `reference`) with per-type guidance on when to save, body structure, and the `Rule → Why → How to apply` scaffold for `feedback`/`project` types.
- **Proactive save triggers** in `SKILL.md` — type-driven "save proactively when..." list replaces vague "when in doubt" prose.
- **Freshness verification** section in `SKILL.md` — verify file paths, function names, and config flags against the codebase before acting on memory.
- **Cross-linking convention** in `SKILL.md` — `[[slug]]` syntax to reference related topic files in body content.
- **`mode` parameter** on `write_memory` (`"append"` | `"replace"`, default `"append"`). `"replace"` overwrites the topic body preserving frontmatter — mirrors `overwrite: true` semantics. Backwards compatible: `overwrite: true` still works as a deprecated alias.
- **Pin-preservation note** in `SKILL.md` — `write_memory(pin: false)` on an already-pinned entry does not unpin it; must use `pin_memory({ pin: false })` explicitly.
- **TUI browser section** in `SKILL.md` — keybindings and usage for the `/memory` interactive browser and `/memory search`.

### Changed

- **`never_persist` defaults** rewritten to principle-based exclusions: code patterns derivable from codebase, git history, debugging fix recipes, ephemeral task state, things in AGENTS.md/CLAUDE.md, large code blocks. Existing `RULES.jsonc` on disk is unaffected — only fresh installs receive the new defaults.
- **`maintainIndex` two-pass rewrite** — pass 1 builds `Map<filename, best_line>` (most-recent date wins, orphans excluded); pass 2 rebuilds in original order. No null values in result, no `.filter()` call. Behavior equivalent for well-formed indexes.
- **`readMemoryIndex` byte/line truncation** split into two separate messages: line-limit (`exceeds N-line limit`) and byte-limit (`exceeds 25 KB size limit`).

### Fixed

- `INITIAL_RULES_JSONC` had duplicate `max_lines`, `stale_after_days`, `inject_every_n_turns` keys appended after `auto_resume_after_threshold_compaction` — removed.
- `compaction_end` handoff-aware detection now correctly scoped to `reason === 'threshold' && !willRetry` (previously fired on all compaction reasons including manual and overflow).
- Removed unused `DEFAULT_AUTO_RESUME_AFTER_THRESHOLD` local const in `index.ts`.
- **TUI browser: removed entry persisted in list after remove (BUG)** — `browseEntries` used `?? e` fallback when re-reading the index after a mutation, which re-inserted removed entries (their filename is gone from the index so `byFile.get()` returned `undefined`, triggering the fallback). Fixed by dropping the fallback and filtering `undefined` — removed entries now disappear from the list immediately on the next loop iteration.

## [0.0.4] - 2026-08-09

### Added

- **Auto-resume after threshold compaction** — opt-in nudge (`auto_resume_after_threshold_compaction` in `RULES.jsonc`) + handoff-aware keyword detection to send `"Continue."` when agent finishes a task and threshold compaction fires. Handoff content is scanned for keywords ("need to", "should", "waiting for", "pending", "next", "then") to detect incomplete work - directly complements 0.0.3 `compaction handoff` feature.

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
