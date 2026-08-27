# How pi Handles Memory Injection

[Back to README](../README.md)

Understanding this is important before configuring or depending on memory behavior.

## pi does not have a persistent system prompt

In pi, there is no mechanism to inject content once at session start and have it remain visible for the entire session. Every turn, pi constructs the system prompt from scratch. Content that is not re-injected on a given turn is **not present in the system prompt for that turn's LLM call**.

This is fundamentally different from tools like opencode, where `system.transform` fires on every internal LLM call and can maintain a persistent block throughout a session.

## How this extension works around it

This extension uses pi's `before_agent_start` hook, which fires **once per user prompt**. On each firing, the hook decides whether to append `## Global Memory` (the MEMORY.md index) and `## Memory Rules` to the system prompt for that turn. The index is read up to a fixed 50 KiB prefix before injection; if it is larger, the injected block says it was truncated instead of loading the whole file.

The injection schedule:

```
Turn 1            → inject  (first prompt of session)
Turns 2, 3, 4     → skip
Turn 5            → inject  (every inject_every_n_turns, default 5)
Turns 6, 7, 8, 9  → skip
Turn 10           → inject
…
```

On skipped turns, `## Global Memory` is **absent from the system prompt entirely**. The agent relies on what it already read and processed from the most recent injected turn — it is not re-reading the index, it is working from its own context window recall.

## What this means in practice

- **The agent may not see index updates immediately.** If a topic is written via `write_memory` on turn 3, the updated index is not injected until turn 5. The agent knows about it because it made the write — but a fresh read of the index won't appear in the system prompt until the next scheduled injection.

- **Between injections, memory is not explicitly in context.** The agent can still act on memories it recalls from earlier in the conversation, but the index is not actively present in the system prompt on every turn.

- **Set `inject_every_n_turns: 1` if you need the index always visible.** This injects on every user prompt. The cost is ~265 tokens of fixed overhead plus ~35 tokens per index entry on every turn — see [Token overhead](architecture.md#token-overhead).

- **Context compaction resets injection.** When context is compacted (`session_before_compact`), the injection state resets so the first turn after compaction always re-injects, regardless of where the turn counter was. The compaction handoff (if enabled) is also injected on that first post-compaction turn.

- **`session_start` does not inject anything.** It only bootstraps the memory directory and files if they are missing, and resets the injection state flags. No content reaches the LLM at session start.

## Why not inject on every turn by default?

Token cost. At 300 index entries, a single injection is ~10,800+ tokens. At `inject_every_n_turns: 5`, that cost is amortized across 5 turns. See [Token overhead](architecture.md#token-overhead) for a full breakdown and the savings table.
