# Compaction Handoff & Auto-Resume

[Back to README](../README.md)

## Compaction Handoff

When pi compacts the context — whether triggered manually (`/compact`), automatically at a token threshold, or by a context overflow — the agent loses everything it was working on. The next prompt starts from the compaction summary, which covers what happened but not what was *in progress*.

The compaction handoff addresses this. When `session_before_compact` fires, the extension extracts the last assistant messages from the conversation history that is about to be discarded, converts them to terse bullet points, and writes a dated entry to `~/.pi/agent/HANDOFF.md`. On the next user prompt, that entry is injected into the system prompt alongside `MEMORY.md` — clearly labelled so the agent knows to resume from it. It is injected exactly once per compaction event and then suppressed, so it does not add recurring overhead to subsequent turns.

Example of what gets injected:

```
## Compaction Handoff

What the agent was working on before the last context compaction.
Resume from here without asking the user to re-explain.

## 2026-08-08T10:14:22+08:00 (threshold)

- Editing extensions/index.ts to add full box borders to all overlays
- Replaced DynamicBorder + Container pattern with borderedBox() helper
- Three overlays updated: confirm, list, detail view
- Removed DynamicBorder and Container imports
```

The file is pruned automatically — by default only the last 3 compaction entries are kept. Configure via `handoff_keep` in `memory.jsonc`. Set to `0` to disable the feature entirely.

## Auto-Resume After Threshold Compaction (opt-in)

When the agent finishes a task and threshold compaction fires, the extension can optionally send a `"Continue."` follow-up message to nudge the agent back into work without requiring user input.

**Two modes:**
1. **Config-based nudge** — if `auto_resume_after_threshold_compaction: true` in `memory.jsonc`, sends `"Continue."` after ALL threshold compactions.
2. **Handoff-aware detection** — automatically sends `"Continue."` if the handoff content contains keywords suggesting incomplete work (e.g. "need to", "should", "waiting for", "pending", "next", "then"). Works regardless of the config setting.

**Why it's safe:** Threshold compaction only fires after turns with no tool calls, meaning the agent has finished its current task. The nudge is appropriate here — it's saying "you finished that task, what's next?"

**When it fires:**
- Config mode: any threshold compaction where `willRetry === false`
- Detection mode: any threshold compaction where `willRetry === false` and the handoff contains continuation keywords

Both modes are gated on `reason === 'threshold' && !willRetry` — manual `/compact` and overflow compactions never trigger it.

`consolidate_on_compact: true` in `memory.jsonc` supersedes both modes — when consolidation is enabled, it fires instead of the plain `"Continue."` nudge. The extension uses pi's already-generated compaction summary as input (captured at `session_compact`), so the agent only needs to extract facts — no full conversation scan.
