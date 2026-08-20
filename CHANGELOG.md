# Changelog

All notable changes to this project will be documented in this file.

## [0.3.2] - 2026-08-19 BUGFIXES + HARDENING

### Fixed
- `compaction_end` was never delivered by the pi runtime (verified against installed `@earendil-works/pi-coding-agent`) — `auto_resume_after_threshold_compaction`, `consolidate_on_compact`, and handoff-aware auto-resume were silently inert. Moved the logic to `session_compact`, which is actually wired to extensions
- JSONC comment-stripping regex broke on `//` inside string values (e.g. a URL) — silently reset the whole config to defaults. Now string-literal-aware
- `maintainIndex` only ran on `write_memory`, not `remove_memory`/`pin_memory` as `docs/configuration.md` claimed — now runs on all three
- `readHandoff()` lacked the legacy-path migration `writeHandoff()` had — a pre-upgrade `HANDOFF.md` could be missed on first read after upgrading
- Path traversal via unsanitized filenames parsed from `MEMORY.md` — filenames containing `/`, `\`, or `..` are now rejected at parse time
- `write_memory`'s prompt guideline referenced a non-existent `overwrite: true` param — corrected to `mode: "replace"`
- Two bugs caught by the new type-checking below: a missing `description` theme function in the `/memory remove` confirmation dialog; `executeWriteMemory`'s `overwrite` param missing a default
- `remove`/`pin` on an ambiguous topic query's exact name match wins outright, ambiguous query refuses to mutate and lists the candidates instead
- Silent `catch` blocks (config parse, index read, `shared_dir` carry-over) now emit a `[openpi-memory]` diagnostic to stderr instead of failing invisibly — the config-parse path dedups so a persistently-broken `memory.jsonc` logs once, not every turn

### Added
- `tsconfig.json` + `npm run typecheck`, wired into CI — `extensions/index.ts` was never statically checked before
- CI now runs `npm test`/`typecheck` on every push/PR and before publish — previously never ran in CI at all
- Documented the unlocked `shared_dir` carry-over race as a known, scoped limitation (`docs/faq.md`, `docs/shared-directory.md`)
- `decideCompactionAction` pure function extracted from the `session_compact` handler so the auto-resume is unit-testable without a live pi session
- `writeHandoff` now returns a `'written' | 'empty' | 'disabled'` status; a compaction that produces no handoff is now logged
- Advisory `peerDependencies` on `@earendil-works/pi-coding-agent`/`pi-tui` (`>=0.84.2`, the verified floor) + a supported-version note in the README — not hard-enforced (pi provides its own copy at runtime); the real drift-catcher stays `npm run typecheck`

## [0.3.1] - 2026-08-19 HOTFIX++

### Changed
- `shared_dir` carry-over is now merge-aware: appends missing local entries into the shared `MEMORY.md` instead of skipping when the shared dir already has content (e.g. written by openclaude-memory); filename collisions with differing content are resolved with a `-opim` suffix; identical-content collisions are a no-op
- `shared_dir` carry-over completion is now marked by a sentinel file (`~/.pi/agent/memory/.shared-dir-migrated`) instead of only an in-process flag — every process start after the first successful merge skips it in a single `fs.existsSync` check instead of re-reading and re-comparing every local and shared file on every pi session start

## [0.3.0] - 2026-08-16

### Added
- `shared_dir` config key (boolean, default `false`) — opt-in: when `true`, redirects the memory index and topic files from `~/.pi/agent/memory/` to `~/.agents/memory/`, a location intended to be shared across tools using the same on-disk format (e.g. openclaude-memory for opencode)
- One-time local carry-over when `shared_dir` first resolves `true`: existing index + topic files are backed up to `~/.pi/agent/memory-backup-before-shared-dir/`, then copied (never moved) into the shared directory; the legacy directory and its files are never modified or deleted; existing files at the destination are never overwritten; runs at most once
- Real cross-process advisory file lock (`.lock` file, atomic `wx` create, ~10s staleness reclaim) replacing the previous in-process-only mutex — needed once the memory directory can be shared by more than one process
- Atomic writes for `MEMORY.md` and topic files (write to temp file, then rename) — removes the risk of a partial/corrupted file on crash or lock failure mid-write
- `getMemoryDir()` / `getMemoryIndex()` exports — resolve the active storage location based on `shared_dir`; replace the old fixed `MEMORY_DIR` / `MEMORY_INDEX` constants

### Changed
- Config file renamed and relocated: `RULES.jsonc` (inside `memory/`) → `memory.jsonc` (one level up, sibling of `memory/`) — config now always stays per-tool regardless of `shared_dir`
- `parseRules()` falls back to the legacy `RULES.jsonc` path when `memory.jsonc` doesn't exist yet: backs it up to `RULES.jsonc.bak`, then copies its content forward; the legacy file is never deleted or moved

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
