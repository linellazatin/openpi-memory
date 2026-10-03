# Architecture & Internals

[← Back to README](../README.md)

## Architecture

This is a pi **extension** packaged as a **pi package** (keyword `pi-package`, installable via `pi install`). No build step — pi loads the TypeScript via jiti at runtime.

**Extension entry:** `extensions/index.ts`  
**Core logic:** `extensions/memory-core.mjs` (plain JS, no pi imports — independently testable)  
**Skill:** `skills/memory/SKILL.md`

Hooks used:

| Hook                     | Purpose                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `session_start`          | Read/create local config, read a missing index in memory, await locked recap retirement, and reset injection state |
| `before_agent_start`     | Inject `MEMORY.md` + rules + latest handoff entry into system prompt (once per user prompt) |
| `session_before_compact` | Write compaction handoff to `HANDOFF.md`; reset injection state so next prompt re-injects  |
| `session_compact`        | Auto-resume/consolidation after completed threshold compaction; handoff-aware fallback sends `"Continue."` only for explicit unfinished-work language |

`write_memory` also carries `promptSnippet` and `promptGuidelines` so the model always has a reminder to persist, even on turns where the full memory block is not injected.

`before_agent_start` returns a full `systemPrompt` replacement rather than patching pi's diffed `systemPromptOptions.sections`. On pi `>=0.87` this is a whole-prompt cache miss whenever the memory block re-injects (every `injectEveryNTurns`); non-injected turns keep pi's normal cached prompt. Pi still recommends the sections route (unchanged through `1.0.0`), but memory is free-form text that changes across sessions, so this cost is accepted for simplicity.

Mutations capture the directory acquired by `withLock` and retain it across config changes. Local contention refuses after about 500 ms; shared mode waits about 2 s and retries once after a 1 s delay. Startup recap retirement is async and locked; missing-index reads never create an index. Migration acquires local then shared, respects both removal lists, and marks success only after completion. Lock liveness treats `EPERM` as alive and stale reclaim rechecks inode/mtime.

Mutation reads verify no-follow regular-file descriptors; preview/search reads are bounded to 50 KiB after opening. Nonblocking open refuses FIFOs without hanging. Config reads permit trusted symlink targets but still require regular descriptors; exclusive config publication preserves racing creators and existing backups. Writes flush exclusive temporary files, publish by rename, and clean temporary files. Normal write failures attempt topic/index rollback; shared removals record intent before dropping discoverability. A new topic reuses an unindexed file only when its frontmatter name matches, otherwise it gets a free numeric suffix. Both write modes refresh current name/description/timestamp metadata, preserving creation and other fields.

Atomicity is per file. Abrupt termination can leave unindexed topics or stale index metadata; directories are not fsynced. The advisory lock has no atomic compare-and-unlink primitive and assumes cooperating same-user writers on local filesystems. Update both implementations before relying on coordinated shared storage.

## System architecture

These diagrams are derived from the current source (`extensions/index.ts`, `extensions/memory-core.mjs`) and the on-disk store layout.

### Component map

End-to-end component view: the pi host dispatches into the extension surface (`index.ts`), which delegates to the pi-free core (`memory-core.mjs`), which reads and writes the flat-file stores under cross-process locks.

```mermaid
flowchart TB
  classDef host fill:#eef2ff,stroke:#4263eb,color:#111,stroke-width:1px
  classDef ext fill:#fff4e6,stroke:#e8590c,color:#111,stroke-width:1px
  classDef core fill:#e6fcf5,stroke:#0ca678,color:#111,stroke-width:1px
  classDef store fill:#f3f0ff,stroke:#7048e8,color:#111,stroke-width:1px
  classDef peer fill:#fff0f0,stroke:#e03131,color:#111,stroke-width:1px,stroke-dasharray:3 2

  subgraph HOST["pi coding agent (host runtime)"]
    direction LR
    EV["event bus"]
    LLM["model + system prompt"]
    TUI["TUI overlay host"]
    CMDIN["slash command input"]
    TOOLRUN["tool dispatcher"]
  end

  subgraph EXT["extensions/index.ts - extension surface"]
    direction TB
    INJ["injection state<br/>_injectedOnce · _turnCount<br/>_handoffConsumed · _lastCompactionSummary"]
    H1["session_start"]
    H2["before_agent_start"]
    H3["session_before_compact"]
    H4["session_compact"]
    T1["write_memory"]
    T2["remove_memory"]
    T3["pin_memory"]
    CM["/memory command<br/>list · detail · confirm overlays"]
  end

  subgraph CORE["extensions/memory-core.mjs - core (no pi imports)"]
    direction TB
    CFG["config<br/>parseRules · stripJsonc · renderRules"]
    DIR["directory + carry-over<br/>getMemoryDir · mergeLocalIntoShared"]
    LOCK["locking<br/>withLock · try/releaseLock · liveness"]
    IO["safe I/O<br/>readStoreFile · readTextPrefix · atomicWrite"]
    IDX["index<br/>parseIndexLine · upsertIndexLine · maintainIndex"]
    MUT["mutations<br/>executeWrite · executeRemove · executePin"]
    HAND["handoff<br/>writeHandoff · replaceLatest · readHandoff"]
    DEC["compaction decision<br/>decideCompactionAction · prompts"]
    DISP["display + search<br/>readIndexEntries · readTopicContent · searchMemory"]
    TOMB["removal intent<br/>.ocl-removed add/remove"]
    RET["startup cleanup<br/>retireRecapEntries"]
  end

  subgraph STORE["flat-file storage"]
    direction TB
    CFGF["~/.pi/agent/memory.jsonc<br/>per-tool config"]
    HF["~/.pi/agent/HANDOFF.md<br/>pi-only orientation"]
    subgraph LOCAL["local store: ~/.pi/agent/memory/"]
      LM["MEMORY.md index"]
      LT["topic .md files"]
      LLK[".lock"]
      LSENT[".shared-dir-migrated"]
      LREM[".ocl-removed"]
    end
    subgraph SHARED["shared store: ~/.agents/memory/ (shared_dir: true)"]
      SM["MEMORY.md index"]
      ST["topic .md files"]
      SLK[".lock"]
      SREM[".ocl-removed"]
    end
  end

  PEER["openclaude-memory (OpenCode)<br/>shares .lock + .ocl-removed"]

  EV --> H1
  EV --> H2
  EV --> H3
  EV --> H4
  TOOLRUN --> T1
  TOOLRUN --> T2
  TOOLRUN --> T3
  CMDIN --> CM

  H1 --> CFG
  H1 --> DIR
  H1 --> RET
  H2 --> CFG
  H2 --> DISP
  H2 --> HAND
  H2 -.->|read/write state| INJ
  H3 --> CFG
  H3 --> HAND
  H3 -.->|reset state| INJ
  H4 --> DEC

  T1 --> MUT
  T2 --> MUT
  T3 --> MUT
  CM --> DISP
  CM --> MUT
  CM -.->|renders| TUI

  MUT --> LOCK
  MUT --> IO
  MUT --> IDX
  MUT --> TOMB
  DIR --> LOCK
  DIR --> IO
  IDX --> IO
  HAND --> IO
  RET --> LOCK
  RET --> IO
  DISP --> IO
  DEC --> HAND

  LOCK -->|guards| LOCAL
  LOCK -->|guards| SHARED
  IO --> LOCAL
  IO --> SHARED
  CFG --> CFGF
  HAND --> HF
  LOCAL -.->|shared_dir carry-over| SHARED
  SHARED -.->|co-writes| PEER

  H2 -.->|injects| LLM
  H4 -.->|sendUserMessage| LLM

  class EV,LLM,TUI,CMDIN,TOOLRUN host
  class INJ,H1,H2,H3,H4,T1,T2,T3,CM ext
  class CFG,DIR,LOCK,IO,IDX,MUT,HAND,DEC,DISP,TOMB,RET core
  class CFGF,HF,LM,LT,LLK,LSENT,LREM,SM,ST,SLK,SREM store
  class PEER peer
```

### Session lifecycle and injection

Ordered flow across the four hooks: startup bootstrap, per-prompt scheduled injection, tool mutations, and compaction handoff / auto-resume.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant P as pi host
  participant E as index.ts (extension)
  participant C as memory-core.mjs
  participant S as Flat-file store

  Note over U,S: Session start
  P->>E: session_start
  E->>C: parseRules()
  C->>S: read memory.jsonc (exclusive publish if missing)
  E->>C: readMemoryIndex(MAX_LINES)
  C->>S: read MEMORY.md read-only (in-memory placeholder if missing)
  E->>C: retireRecapEntries() async + locked
  C->>S: strip last-session-recap (record .ocl-removed when shared)
  E->>E: reset _injectedOnce, _turnCount, _handoffConsumed

  Note over U,S: Every user prompt
  U->>P: prompt
  P->>E: before_agent_start
  E->>C: parseRules()
  alt first prompt or _turnCount % inject_every_n_turns == 0
    E->>C: readMemoryIndex(maxLines)
    C->>S: bounded read MEMORY.md (50 KiB)
    E->>C: renderRulesToMarkdown(rules)
    E->>C: readHandoff() once
    C->>S: read latest HANDOFF.md section
    E-->>P: systemPrompt + Global Memory + Memory Rules + Compaction Handoff
  else scheduled skip
    E-->>P: no change (memory block absent this turn)
  end
  P->>P: model call

  Note over U,S: Tool call
  P->>E: write_memory / remove_memory / pin_memory
  E->>C: executeWrite / executeRemove / executePinMemory()
  C->>C: withLock(memoryDir)
  C->>S: read index, write topic + index atomically (rollback on failure)
  C-->>E: result text
  E-->>P: tool result

  Note over U,S: Context compaction
  P->>E: session_before_compact
  E->>C: writeHandoff(messagesToSummarize, reason)
  C->>S: append + prune HANDOFF.md
  E->>E: reset injection state
  P->>E: session_compact
  E->>C: decideCompactionAction(rules, handoff)
  alt consolidate_on_compact
    E->>C: replaceLatestHandoffWithCompactionSummary()
    E-->>P: sendUserMessage(consolidation prompt, followUp)
  else auto_resume or unfinished handoff
    E-->>P: sendUserMessage("Continue.", followUp)
  else none
    E->>E: no-op
  end
```

### Mutation / write path

`executeWriteMemory` from validation through slug resolution, atomic topic + index writes, and per-file rollback on failure.

```mermaid
flowchart TD
  A["write_memory<br/>topic · content · summary · pin · mode"] --> B{"normalize metadata<br/>blank / newline / markdown chars / reserved slug?"}
  B -->|invalid| ERR["return error text"]
  B -->|valid| C["withLock(acquired memoryDir)<br/>local 500 ms · shared 2 s + 1 s retry"]
  C --> D{"lock acquired?"}
  D -->|no| BUSY["LOCK_BUSY_MESSAGE"]
  D -->|yes| E["read index (bounded) or INITIAL_MEMORY"]
  E --> F{"exact topic name in index?"}
  F -->|yes| G["reuse indexed filename"]
  F -->|no| H["filename = toSlug(topic).md"]
  H --> I{"slug indexed or on disk?"}
  I -->|no| G2["use slug"]
  I -->|"unindexed file, frontmatter name matches"| G3["reuse disk file"]
  I -->|otherwise| G4["numeric suffix -2, -3 ..."]
  G --> J
  G2 --> J
  G3 --> J
  G4 --> J["read previous topic if it exists"]
  J --> K["merge frontmatter<br/>name · description · last_updated<br/>preserve created + other fields"]
  K --> L{"mode replace, or new file?"}
  L -->|yes| M["body = new content"]
  L -->|no| N["body = old body + dated heading + content"]
  M --> O["try: atomicWriteFileSync(topic)"]
  N --> O
  O --> P["upsertIndexLine + maintainIndex<br/>orphans · dedupe · stale stamping"]
  P --> Q["atomicWriteFileSync(MEMORY.md)"]
  Q --> R{"shared dir?"}
  R -->|yes| S["remove .ocl-removed tombstone"]
  R -->|no| T["release lock · success"]
  S --> T
  O -->|error| U["catch: rollback"]
  P -->|error| U
  Q -->|error| U
  U --> V["restore index if written<br/>restore topic or unlink new<br/>re-add tombstone if it was removed"]
  V --> W{"rollback ok?"}
  W -->|no| X["AggregateError - inspect topic + index"]
  W -->|yes| Y["rethrow original error"]
```

### `shared_dir` carry-over and cross-tool coordination

One-time local-to-shared migration and the shared-store conventions (`.lock`, `.ocl-removed`) shared with openclaude-memory on OpenCode.

```mermaid
flowchart TD
  A["getMemoryDir()"] --> B{"memory.jsonc: shared_dir?"}
  B -->|false| L["local store<br/>~/.pi/agent/memory/"]
  B -->|true| C["maybeCarryOverLocalMemory()"]
  C --> D{".shared-dir-migrated sentinel?"}
  D -->|yes| S["shared store<br/>~/.agents/memory/"]
  D -->|no| E{"local MEMORY.md exists?"}
  E -->|no| S
  E -->|yes| F["acquire local .lock"]
  F -->|busy| RETRY["skip this call, retry on a later one"]
  F -->|ok| G["mkdir shared, acquire shared .lock"]
  G -->|busy| RETRY
  G -->|ok| H["mergeLocalIntoSharedDir()"]
  H --> I["union .ocl-removed tombstones from BOTH stores"]
  I --> J["for each local index entry"]
  J --> K{"removed / orphan / unsafe?"}
  K -->|yes| J
  K -->|no| M["resolveDestName<br/>no collision / identical / -opim / -opim-N"]
  M --> N{"shared topic file absent?"}
  N -->|yes| O["atomic copy topic file"]
  N -->|no| P["keep existing shared file"]
  O --> Q{"shared index entry absent?"}
  P --> Q
  Q -->|yes| R["append index line with rewritten filename"]
  Q -->|no| J
  R --> J
  J --> T["atomic write shared MEMORY.md"]
  T --> U["atomic write sentinel"]
  U --> S
  S --> V["shared mutations run under .lock<br/>remove writes .ocl-removed<br/>re-store clears the tombstone"]
  V --> W["openclaude-memory (OpenCode)<br/>co-writes the same directory"]
```

### Store data model

The on-disk artifacts and how config policy, handoff, tombstones, and the lock relate to the `MEMORY.md` index.

```mermaid
flowchart LR
  M["MEMORY.md (index)<br/>- [Name](topic.md) [pin] ISO-datetime [stale?] -- summary"]
  T["topic .md<br/>---<br/>name: string<br/>description: string<br/>created: ISO<br/>last_updated: ISO<br/>metadata:<br/>  node_type: memory<br/>---<br/>body"]
  R["memory.jsonc<br/>always_persist<br/>never_persist<br/>always_ask<br/>max_lines (50-1000)<br/>stale_after_days (0=off)<br/>inject_every_n_turns<br/>handoff_keep (0=off)<br/>auto_resume_after_threshold_compaction<br/>consolidate_on_compact<br/>shared_dir"]
  H["HANDOFF.md<br/>## ISO-datetime (reason)<br/>- bullets, keep last handoff_keep sections"]
  K[".lock<br/>PID + timestamp + random token"]
  SE[".shared-dir-migrated<br/>carry-over done sentinel"]
  B[".ocl-removed<br/>one topic filename per line<br/>shared-store tombstone"]
  M -->|links to| T
  R -->|policy rendered into prompt| M
  H -->|injected once after compaction| M
  B -->|suppresses re-index| M
  K -.->|guards| M
  SE -.->|gates carry-over| M
```

## Model compatibility

The extension injects markdown and registers validated tools. Storage safeguards are independent of model size; automatic persistence and factual quality are model decisions. The tables below are usage estimates, not benchmarks or guarantees for particular models.

| Feature                                   | Large (20B+)         | Small-Mid (>7B <20B) | Compact (<7B)        |
| ----------------------------------------- | -------------------- | -------------------- | -------------------- |
| `/memory` show index                      | Reliable             | Reliable             | Reliable             |
| `/memory <text>` store via `write_memory` | Reliable             | Reliable             | Reliable             |
| `/memory pin/unpin/remove`                | Reliable             | Reliable             | Reliable             |
| Auto-trigger writes (persist rules)       | Reliable             | Reliable             | Usually works        |
| Topic/summary quality on auto-writes      | Reliable             | Reliable             | Usually works        |
| `[stale?]` flagging and self-healing      | Extension-guaranteed | Extension-guaranteed | Extension-guaranteed |

For compact or edge models, `/memory <text>` explicit commands are always more reliable than relying on auto-trigger writes.

## Token overhead

Estimates use cl100k-compatible tokenization (~4 chars/token for English prose, ~3 chars/token for paths and datetime strings). All figures are approximate.

### Per-turn base — always present

`write_memory`'s `promptSnippet` and three `promptGuidelines` bullets are injected into the system prompt on **every turn**, regardless of `inject_every_n_turns`:

| Component                                      | ~Tokens  |
| ---------------------------------------------- | -------- |
| Tool snippet ("Persist facts, preferences…")  | 20       |
| Guideline: when to call write_memory           | 47       |
| Guideline: check Memory Rules                  | 25       |
| Guideline: mode replace vs append              | 37       |
| **Per-turn base**                              | **~130** |

### Injection cost — added on injected turns

| Component                                               | ~Tokens  |
| ------------------------------------------------------- | -------- |
| `## Global Memory` heading, preamble, memory dir path   | 59       |
| `## Memory Rules` heading, preamble, memory.jsonc path   | 45       |
| Default rules content (3 sections, 11 bullets)          | 157      |
| `# Memory Index` header                                 | 4        |
| **Fixed injection overhead**                            | **~265** |
| Per index entry (name, filename, ISO datetime, summary) | ~35      |

The per-entry cost is for a typical line with a full ISO datetime stamp and a one-sentence summary. Pinned or stale entries add ~2–3 tokens each.

### Compaction handoff cost — first post-compaction turn only

The handoff entry is injected exactly once — on the first prompt after a compaction event — then suppressed for the remainder of the session.

| Component                                                      | ~Tokens  |
| -------------------------------------------------------------- | -------- |
| `## Compaction Handoff` heading + 2-line preamble              | ~30      |
| Entry header (`## ISO datetime (reason)`)                      | ~15      |
| Bullet content — typical (5–8 bullets)                         | ~70      |
| Bullet content — maximum (15 bullets cap)                      | ~180     |
| **Typical handoff overhead**                                   | **~115** |
| **Maximum handoff overhead**                                   | **~225** |

Set `"handoff_keep": 0` in `memory.jsonc` to disable entirely.

### Auto-resume nudge cost

| Component             | ~Tokens |
| --------------------- | ------- |
| `"Continue."` message | 2       |

Negligible. Only fires on threshold compaction — not overflow or manual.

### Total per injected turn

| Scenario               | Entries | Injection | Always | **Total**  |
| ---------------------- | ------- | --------- | ------ | ---------- |
| Fresh install          | 0       | ~265      | ~130   | **~395**   |
| Normal use             | 10      | ~615      | ~130   | **~745**   |
| Active use             | 25      | ~1,140    | ~130   | **~1,270** |
| Fully loaded           | 50      | ~2,015    | ~130   | **~2,145** |
| At `max_lines: 300` cap | ~297   | ~10,660   | ~130   | **~10,790** |

With `inject_every_n_turns: 5` (default), the amortized cost per turn is `(injection + 4 × base) ÷ 5`:

| Scenario                  | Amortized/turn |
| ------------------------- | -------------- |
| Normal use (10 entries)   | **~253**       |
| Fully loaded (50 entries) | **~533**       |
| At cap (297 entries)      | **~2,256**     |

Non-injected turns cost only the per-turn base: **~130 tokens**.

For context: 10,790 tokens is ~5.4% of a 200k context window. A 50-entry index stays well under 2,200 tokens per injected turn.

### Savings from throttling

**Default `inject_every_n_turns: 5` over a 20-turn session** (injects at turns 1, 5, 10, 15, 20 — 5 injections, 15 skipped):

| Index size | N=1 total (baseline) | N=5 total | Tokens saved | % saved |
| ---------- | -------------------- | --------- | ------------ | ------- |
| 10 entries | ~14,900              | ~5,675    | **~9,225**   | 62%     |
| 20 entries | ~22,700              | ~7,825    | **~14,875**  | 66%     |
| 30 entries | ~28,900              | ~9,175    | **~19,725**  | 68%     |

**Effect of different N values — 20-turn read-heavy session, 10-entry index:**

| `inject_every_n_turns` | Injections / 20 turns | Session total | vs N=1     | Saved   |
| ---------------------- | --------------------- | ------------- | ---------- | ------- |
| 1 (every turn)         | 20                    | ~14,900       | —          | —       |
| 3                      | 7                     | ~6,905        | ~7,995     | 54%     |
| **5 (default)**        | **5**                 | **~5,675**    | **~9,225** | **62%** |
| 10                     | 3                     | ~4,445        | ~10,455    | 70%     |
| 20                     | 2                     | ~3,830        | ~11,070    | 74%     |

Higher N saves more tokens but increases the gap between memory rule refreshes. For read-heavy sessions, N = 10–20 is reasonable. For write-heavy sessions where the agent actively stores new entries, keep N at 5 or lower so the rules stay recent in context.

## Development

```bash
# Run both smoke suites (core logic + host-load extension wiring)
npm test

# Core logic smoke tests only (no install required — plain node, no pi imports)
node tests/core.test.mjs

# Host-load smoke test (requires npm install — imports @earendil-works/pi-coding-agent)
node tests/extension.test.mjs

# Type-check against the pinned pi baseline
npm run typecheck

# Load extension temporarily without installing
pi -e ./extensions/index.ts
```

Current verification: 134 core checks, 12 real pi-loader checks, and typecheck on pi 0.99.1 and pi 1.0.0 (the lockfile/CI dev baseline is 1.0.0). From an OpenCode sibling checkout, `node tests/shared-store-test.mjs /absolute/path/to/openpi-memory/extensions/memory-core.mjs` also checks parallel real-process writes, pins, removals, foreign entries, and cleanup in temporary storage. Interactive rendering and model decisions are separate from these loader/storage checks.
