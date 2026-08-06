# openpi-memory

[![npm version](https://img.shields.io/npm/v/@openlines/openpi-memory)](https://www.npmjs.com/package/@openlines/openpi-memory)
[![license](https://img.shields.io/npm/l/@openlines/openpi-memory)](./LICENSE)

Global persistent memory for [pi coding agent](https://pi.dev) sessions. **Open. Configurable.** Inspired by Claude Code's auto-memory — your agent remembers what it learns, across every session, globally.

A port of [openclaude-memory](https://github.com/linellazatin/openclaude-memory) to pi's extension API.

> Considering that vast majority of people who use **pi** literally creates their own extensions, I'm shooting my shot on this memory extension that I believe is good enough to be your *ultra-simplest* memory handler.

## Why

I built this because I genuinely like how Claude Code handles memory: no complex algorithms, no external LLM for heavy lifting, no vector databases. It just works — the agent reads a markdown file and acts on it. Simple, transparent, effective.

I also wanted something local-first. My memories and notes stay on my machine, in plain markdown files I can read, edit, and audit at any time. No cloud sync, no embeddings pipeline, no black-box retrieval. If I want to know what the agent remembers, I open a file.

When something worth remembering happens (a bug fixed, user preferences, a config discovered, a command identified), the agent writes it to a structured markdown memory store — or you tell it to. The next session, that context is already there — injected automatically into the system prompt before the first message.

But this project wasn't born because I wanted to reinvent memory systems. It was born out of frustration.

Over the past several months, I experimented with nearly every approach I could find: vector databases, embedding models, external memory services, MCP memory servers, and LLM-powered memory management. Some were incredibly clever. Some were feature-rich. But almost all of them came with trade-offs that didn't fit how I work.

Running a separate LLM just to decide whether a memory should be saved felt wasteful. Maintaining embedding models and vector indexes consumed resources I'd rather dedicate to the coding model itself. I found myself spending more time configuring the memory system than actually using it.

I also discovered that more intelligence didn't always mean better memory. During my own testing, I audited memories produced by automated systems and found that many retained facts were incomplete, misleading, or simply wrong. If the memory layer itself isn't trustworthy, every future conversation starts from a weaker foundation.

Eventually I asked myself a simple question:

> Why does remembering something require another AI model?

For the kinds of things I actually wanted to remember—project architecture, debugging notes, shell commands, configuration quirks, design decisions—the answer was: it doesn't.

A markdown file is deterministic. It's searchable with Git. It can be reviewed in code reviews. It survives model changes, provider changes, and framework changes. Most importantly, it never hides what the agent knows.

So instead of building another "AI memory," I built a memory system that stays out of the way.

- No embeddings.
- No vector databases.
- No background services.
- No hidden retrieval algorithms.

Just files, structure, and an agent that knows where to look.

> If you've ever spent hours configuring a sophisticated memory stack only to realize you just wanted your coding agent to remember yesterday's bug fix, this project is for you.

## Install

```bash
pi install npm:@openlines/openpi-memory
```

Or from git:

```bash
pi install git:github.com/linellazatin/openpi-memory
```

The extension and skill load automatically after install. No further setup.

## Update

```bash
pi update npm:@openlines/openpi-memory
```

To update all installed packages at once:

```bash
pi update --extensions
```

Versioned installs (e.g. `npm:@openlines/openpi-memory@1.0.0`) are pinned and skipped by `--extensions`. Use `pi install npm:@openlines/openpi-memory@new-version` to move to a specific version.

## Uninstall

```bash
pi remove npm:@openlines/openpi-memory
```

This removes the package from pi's settings. It does not touch your memory files — `~/.pi/agent/memory/` is left intact so nothing is lost. Delete that directory manually if you want to clear stored memories.

## What gets stored where

```
~/.pi/agent/memory/
├── MEMORY.md              # index — injected into every session automatically
├── RULES.jsonc            # persist rules + config
└── <topic>.md             # per-topic detail files, created by write_memory
```

All files are plain text. You can read, edit, and delete them at any time.

The default location respects `PI_CODING_AGENT_DIR` if set (pi's config-dir override).

## Tools

The extension registers three tools the agent uses for all memory operations:


| Tool            | Args                                                | What it does                                                      |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `write_memory`  | `topic`, `content`, `summary`, `pin?`, `overwrite?` | Creates or appends to a topic file; upserts`MEMORY.md` index      |
| `remove_memory` | `topic`                                             | Removes the index entry (refuses if pinned); topic file preserved |
| `pin_memory`    | `topic`, `pin` (bool)                               | Pins or unpins an index entry                                     |

`overwrite: true` replaces the full topic body in-place (frontmatter preserved, `last_updated` refreshed). Use for state entries that should be current — hardware specs, environment config, user preferences. Default (`false`) appends under a `## YYYY-MM-DD` date heading, which is correct for logs of fixes, discoveries, and incremental notes.

Use these instead of asking the agent to edit files directly — they guarantee correct format, frontmatter, and index integrity regardless of model size.

## `/memory` command

![ss-memory-command](ss/ss-memory-command.png)
```
/memory                    → open interactive memory browser
/memory <text>             → store something (agent picks topic, summary, pin)
/memory pin <topic>        → pin an entry
/memory unpin <topic>      → unpin an entry
/memory remove <topic>     → remove an index entry
```

**`/memory` (no args)** opens a navigable overlay browser:

![ss-memory-list](ss/ss-memory-list.png)
- **List view** — all topics with date and pin/stale status. `↑↓` to navigate, `enter` to open a topic, `p` to pin/unpin the highlighted entry in-place, `esc` to close.
- **Detail view** — full Markdown-rendered topic body with metadata. Action list: Pin/Unpin, Remove, Back. `p` hotkey for pin/unpin. Any action or `esc` returns to the list.

**`/memory <text>`** sends the text to the agent with an instruction to call `write_memory`. The agent decides the topic name, filename, summary, and whether to pin it.

`pin`, `unpin`, and `remove` by name run directly in the command handler — no LLM round-trip.

![ss-memory-detail](ss/ss-memory-detail.png)

## Auto-injection

`MEMORY.md` and the rendered rules from `RULES.jsonc` are injected into the system prompt automatically:

- On the **first user prompt** of each session (`_injectedOnce = false`)
- Every **`inject_every_n_turns`** user prompts thereafter (default: 5)
- On the **first prompt after context compaction** (injection state resets on `session_before_compact`)

`inject_every_n_turns` throttles at **user-prompt granularity** in pi. Unlike opencode's `system.transform` (which fired on every internal LLM call), pi's `before_agent_start` fires once per user message. Setting `inject_every_n_turns: 1` injects on every user prompt; `5` means every fifth.

The agent already has memory in its context from prior turns, so re-injection on every prompt is only necessary if you want the index always explicitly visible in the system prompt.

## Token overhead

Estimates use cl100k-compatible tokenization (~4 chars/token for English prose, ~3 chars/token for paths and datetime strings). All figures are approximate.

### Per-turn base — always present

`write_memory`'s `promptSnippet` and three `promptGuidelines` bullets are injected into the system prompt on **every turn**, regardless of `inject_every_n_turns`:


| Component                                     | ~Tokens  |
| ----------------------------------------------- | ---------- |
| Tool snippet ("Persist facts, preferences…") | 20       |
| Guideline: when to call write_memory          | 47       |
| Guideline: check Memory Rules                 | 25       |
| Guideline: overwrite vs append                | 37       |
| **Per-turn base**                             | **~130** |

### Injection cost — added on injected turns


| Component                                               | ~Tokens  |
| --------------------------------------------------------- | ---------- |
| `## Global Memory` heading, preamble, memory dir path   | 59       |
| `## Memory Rules` heading, preamble, RULES.jsonc path   | 45       |
| Default rules content (3 sections, 11 bullets)          | 157      |
| `# Memory Index` header                                 | 4        |
| **Fixed injection overhead**                            | **~265** |
| Per index entry (name, filename, ISO datetime, summary) | ~35      |

The per-entry cost is for a typical line with a full ISO datetime stamp and a one-sentence summary. Pinned or stale entries add ~2–3 tokens each.

### Total per injected turn


| Scenario               | Entries | Injection | Always | **Total**  |
| ------------------------ | --------- | ----------- | -------- | ------------ |
| Fresh install          | 0       | ~265      | ~130   | **~395**   |
| Normal use             | 10      | ~615      | ~130   | **~745**   |
| Active use             | 25      | ~1,140    | ~130   | **~1,270** |
| Fully loaded           | 50      | ~2,015    | ~130   | **~2,145** |
| At`max_lines: 200` cap | ~197    | ~7,160    | ~130   | **~7,290** |

With `inject_every_n_turns: 5` (default), the amortized cost per turn is `(injection + 4 × base) ÷ 5`:


| Scenario                  | Amortized/turn |
| --------------------------- | ---------------- |
| Normal use (10 entries)   | **~253**       |
| Fully loaded (50 entries) | **~533**       |
| At cap (197 entries)      | **~1,510**     |

Non-injected turns (e.g. turns 2–4 with default N = 5) cost only the per-turn base: **~130 tokens**.

For context: 7,290 tokens is ~3.6% of a 200k context window. A 50-entry index stays well under 2,200 tokens per injected turn.

### Savings from throttling

The injection block is skipped on non-injected turns — that is where all the savings come from. The ~130 token per-turn base always applies.

**Default `inject_every_n_turns: 5` over a 20-turn session**

N = 5 injects at turns 1, 5, 10, 15, 20 (5 injections; 15 turns skipped):


| Index size | N=1 total (baseline) | N=5 total | Tokens saved | % saved |
| ------------ | ---------------------- | ----------- | -------------- | --------- |
| 10 entries | ~14,900              | ~5,675    | **~9,225**   | 62%     |
| 20 entries | ~22,700              | ~7,825    | **~14,875**  | 66%     |
| 30 entries | ~28,900              | ~9,175    | **~19,725**  | 68%     |

**Effect of different N values — 20-turn read-heavy session, 10-entry index**

Injection count uses the actual `_turnCount % N === 0` logic (first turn always injects, then every N turns thereafter):


| `inject_every_n_turns` | Injections / 20 turns | Session total | vs N=1     | Saved   |
| ------------------------ | ----------------------- | --------------- | ------------ | --------- |
| 1 (every turn)         | 20                    | ~14,900       | —         | —      |
| 3                      | 7                     | ~6,905        | ~7,995     | 54%     |
| **5 (default)**        | **5**                 | **~5,675**    | **~9,225** | **62%** |
| 10                     | 3                     | ~4,445        | ~10,455    | 70%     |
| 20                     | 2                     | ~3,830        | ~11,070    | 74%     |

Higher N saves more tokens but increases the gap between memory rule refreshes. For read-heavy sessions where the agent only consults the index, N = 10–20 is reasonable. For write-heavy sessions where the agent actively stores new entries, keep N at 5 or lower so the rules stay recent in context.

## RULES.jsonc

`~/.pi/agent/memory/RULES.jsonc` is created with defaults on first run. It is a JSON file with comment support:

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
    "Session-specific context that won't apply to future sessions",
    "Assumed or inferred preferences — only persist what the user has explicitly stated",
    "Large blocks of code — summarize instead, or link to the file path"
  ],
  // Always ask before persisting these
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

The rule arrays (`always_persist`, `never_persist`, `always_ask`) are rendered to markdown and injected into the system prompt. Config scalars (`max_lines`, `stale_after_days`, `inject_every_n_turns`) are consumed by the extension and never injected. Changes take effect on the next user prompt — no reload required.

## Index format

Each line in `MEMORY.md` follows this format:

```
- [Topic Name](filename.md) [pin] YYYY-MM-DDTHH:MM:SS±HH:MM [stale?] -- one-line summary
```

The date stamp is a full ISO 8601 datetime with the host timezone offset (e.g. `2026-08-07T01:15:30+08:00`). Legacy entries with date-only stamps (`YYYY-MM-DD`) remain readable — the extension handles both formats.

- `[pin]` — pinned entries are never cleanup candidates and never flagged stale
- `[stale?]` — entry has not been updated in over `stale_after_days` days
- Both tokens are optional and managed by the extension

## Stale flagging

The extension stamps `[stale?]` on index entries older than `stale_after_days` (default 180). This happens during index maintenance after any write, not on read. The flag self-heals: calling `write_memory` on a stale topic removes it automatically.

Pinned entries are never flagged. Entries with no date are never flagged.

Set `"stale_after_days": 0` to disable age flagging entirely.

## Index maintenance

After every `write_memory`, `remove_memory`, or `pin_memory` call, the extension runs a maintenance pass on `MEMORY.md`:

- **Orphan removal** — removes entries whose topic file no longer exists on disk
- **Deduplication** — keeps the entry with the newer date if two entries share a filename
- **Stale stamping/healing** — applies or removes `[stale?]` based on entry age

Maintenance never runs on read — only on write.

## Architecture

This is a pi **extension** packaged as a **pi package** (keyword `pi-package`, installable via `pi install`). No build step — pi loads the TypeScript via jiti at runtime.

**Extension entry:** `extensions/index.ts`
**Core logic:** `extensions/memory-core.mjs` (plain JS, no pi imports — independently testable)
**Skill:** `skills/memory/SKILL.md`

Hooks used:


| Hook                     | Purpose                                                                       |
| -------------------------- | ------------------------------------------------------------------------------- |
| `session_start`          | Bootstrap`memory/` dir, `MEMORY.md`, and `RULES.jsonc`; reset injection state |
| `before_agent_start`     | Inject`MEMORY.md` + rendered rules into system prompt (once per user prompt)  |
| `session_before_compact` | Reset injection state so first prompt after compaction re-injects             |

`before_agent_start` fires at the start of each user prompt, so the next injection point naturally re-reads fresh state. `write_memory` also carries `promptSnippet` and `promptGuidelines` so the model always has a reminder to persist, even on turns where the full memory block is not injected.

## Model compatibility

The extension injects plain markdown into the system prompt and registers structured tools. Tool calls guarantee correct format and index integrity regardless of model tier — only the model's decision to call the tool (and what args to pass) varies.


| Feature                                   | Large (20B+)         | Small-Mid (>7B <20B) | Compact (<7B)        |
| ------------------------------------------- | ---------------------- | ---------------------- | ---------------------- |
| `/memory` show index                      | Reliable             | Reliable             | Reliable             |
| `/memory <text>` store via `write_memory` | Reliable             | Reliable             | Reliable             |
| `/memory pin/unpin/remove`                | Reliable             | Reliable             | Reliable             |
| Auto-trigger writes (persist rules)       | Reliable             | Reliable             | Usually works        |
| Topic/summary quality on auto-writes      | Reliable             | Reliable             | Usually works        |
| `[stale?]` flagging and self-healing      | Extension-guaranteed | Extension-guaranteed | Extension-guaranteed |

For compact or edge models, `/memory <text>` explicit commands are always more reliable than relying on auto-trigger writes.

## Known limitations

- Module-level injection state (`_injectedOnce`, `_turnCount`) is process-global. Safe for the standard single-user pi session; upgrade to a per-session Map if multi-session support is needed in future.
- Manual edits to `MEMORY.md` or `RULES.jsonc` made between user prompts are picked up on the next `before_agent_start` call (no cache to invalidate). This is by design.
- The `/memory` browser's `p` hotkey tracks the focused item by mirroring `↑↓` key presses. If the SelectList's internal cursor drifts (e.g. via search filtering), `p` may act on a different entry than visually selected. Workaround: open the detail view with `enter` and use the action list there.

## Development

```bash
# Run smoke tests (no install required)
node test.mjs

# Load extension temporarily without installing
pi -e ./extensions/index.ts
```

## License

MIT
