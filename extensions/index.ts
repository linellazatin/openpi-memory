/**
 * openpi-memory extension
 *
 * Provides global persistent memory across pi sessions via MEMORY.md injection.
 * Modeled after openclaude-memory (opencode), ported to pi's extension API.
 *
 * Storage: ~/.pi/agent/memory/   (or $PI_CODING_AGENT_DIR/memory/)
 *   MEMORY.md   — index, injected into system prompt
 *   RULES.jsonc — persist rules + config scalars
 *   <topic>.md  — per-topic detail files
 *
 * Hooks used:
 *   session_start          — bootstrap memory dir + files; reset injection state
 *   before_agent_start    — inject memory + rules into system prompt (once per user prompt)
 *   session_before_compact — reset injection state so next prompt always re-injects
 *   compaction_end         — auto-resume nudge after threshold compaction
 *
 * Tools registered: write_memory, remove_memory, pin_memory
 * Command registered: /memory
 */

import { Type } from 'typebox';
import { getMarkdownTheme, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type Component, Markdown, matchesKey, type SelectItem, SelectList, Spacer, Text, visibleWidth } from '@earendil-works/pi-tui';
import {
  MEMORY_DIR,
  MEMORY_RULES,
  MAX_LINES,
  CONSOLIDATION_PROMPT,
  buildCompactionConsolidationPrompt,
  parseRules,
  renderRulesToMarkdown,
  readMemoryIndex,
  readIndexEntries,
  readTopicContent,
  readHandoff,
  writeHandoff,
  searchMemory,
  detectIncompleteTask,
  executeWriteMemory,
  executeRemoveMemory,
  executePinMemory,
} from './memory-core.mjs';

// Full Unicode box border wrapper.
function borderedBox(colorFn: (s: string) => string, children: Component[]): Component {
  return {
    invalidate() { for (const c of children) c.invalidate?.(); },
    render(width: number) {
      const inner = Math.max(1, width - 2);
      const result: string[] = [];
      result.push(colorFn('┌' + '─'.repeat(inner) + '┐'));
      for (const child of children) {
        for (const line of child.render(inner)) {
          const vis = visibleWidth(line);
          result.push(colorFn('│') + line + (vis < inner ? ' '.repeat(inner - vis) : '') + colorFn('│'));
        }
      }
      result.push(colorFn('└' + '─'.repeat(inner) + '┘'));
      return result;
    },
  };
}

// --- Injection state ---
// process-global; safe for single-user extension.
// Upgrade to per-session Map if multi-session support is needed.
let _injectedOnce = false;
let _turnCount = 0;
let _handoffConsumed = false;
let _lastCompactionSummary: string | null = null;

export default function (pi: ExtensionAPI) {
  // ── session_start ────────────────────────────────────────────────────────
  // Bootstrap memory dir + files on every session start so they exist before
  // the first user prompt (e.g. for editing RULES.jsonc upfront).
  // Also resets injection state so each session begins with a clean slate.

  pi.on('session_start', () => {
    parseRules();               // creates RULES.jsonc with defaults if missing
    readMemoryIndex(MAX_LINES); // creates MEMORY.md if missing
    _injectedOnce = false;
    _turnCount = 0;
    _handoffConsumed = false;
    _lastCompactionSummary = null;
  });

  // ── before_agent_start ──────────────────────────────────────────────────
  // Fires once per user prompt (not per internal LLM call).
  // Reads rules fresh each call — changes to RULES.jsonc take effect immediately.

  pi.on('before_agent_start', async (event) => {
    _turnCount++;
    const rules = parseRules();

    if (!_injectedOnce || _turnCount % rules.injectEveryNTurns === 0) {
      const content = readMemoryIndex(rules.maxLines);
      const rulesMarkdown = renderRulesToMarkdown(rules);

      _injectedOnce = true;

      let extra = '';
      if (content) {
        extra +=
          `\n\n## Global Memory\n\n` +
          `The following is your persistent memory index. It persists across all sessions. ` +
          `Topic files referenced here can be read on-demand for detail.\n\n` +
          `Memory dir: ${MEMORY_DIR}\n\n${content}`;
      }
      if (rulesMarkdown) {
        extra +=
          `\n\n## Memory Rules\n\n` +
          `The following rules govern what to persist or avoid persisting to memory. ` +
          `Edit ${MEMORY_RULES} to customise.\n\n${rulesMarkdown}`;
      }

      const handoff = _handoffConsumed ? '' : readHandoff();
      if (handoff) {
        _handoffConsumed = true;
        extra +=
          `\n\n## Compaction Handoff\n\n` +
          `What the agent was working on before the last context compaction. ` +
          `Resume from here without asking the user to re-explain.\n\n${handoff}`;
      }

      if (!extra) return;
      return { systemPrompt: event.systemPrompt + extra };
    }
  });

  // ── session_before_compact ───────────────────────────────────────────────
  // Reset injection state so the first prompt after compaction always re-injects,
  // regardless of where the turn counter was before compaction.

  pi.on('session_before_compact', async (event) => {
    _injectedOnce = false;
    _turnCount = 0;
    _handoffConsumed = false;
    const rules = parseRules();
    if (rules.handoffKeep > 0) {
      writeHandoff(event.preparation.messagesToSummarize, event.reason, rules.handoffKeep);
    }
  });

  // ── session_compact ──────────────────────────────────────────────────────
  // Capture compaction summary so compaction_end can use it directly instead
  // of asking the agent to re-scan the full conversation history.

  pi.on('session_compact', (event) => {
    _lastCompactionSummary = event.compactionEntry.summary;
  });

  // ── compaction_end ───────────────────────────────────────────────────────
  // Auto-resume after threshold compaction: opt-in nudge + handoff-aware detection

  pi.on('compaction_end', async (event) => {
    if (event.reason !== 'threshold' || event.willRetry) return;

    const rules = parseRules();

    // Consolidation path: extract session facts + write recap instead of plain nudge
    if (rules.consolidateOnCompact) {
      const prompt = _lastCompactionSummary
        ? buildCompactionConsolidationPrompt(_lastCompactionSummary)
        : CONSOLIDATION_PROMPT;
      _lastCompactionSummary = null;
      pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
      return;
    }

    // Config-based nudge: send "Continue." for ALL threshold compactions if enabled
    if (rules.autoResumeAfterThreshold) {
      pi.sendUserMessage('Continue.', { deliverAs: 'followUp' });
      return;
    }

    // Handoff-aware detection: send "Continue." if handoff suggests incomplete work
    const handoff = readHandoff();
    if (handoff && detectIncompleteTask(handoff)) {
      pi.sendUserMessage('Continue.', { deliverAs: 'followUp' });
    }
  });

  // ── write_memory ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'write_memory',
    label: 'Write Memory',
    description:
      'Write or update a memory topic. Creates a new topic file or appends to an existing one. ' +
      'Updates the MEMORY.md index automatically. ' +
      'Use this instead of raw Write/Edit tools for all memory operations.',
    promptSnippet: 'Persist facts, preferences, configs, fixes, and discoveries to long-term memory',
    promptGuidelines: [
      'Use write_memory to persist anything worth remembering across sessions: bugs fixed, explicitly stated user preferences, configs discovered, commands identified, environment facts learned.',
      'Check ## Memory Rules in your context for what to persist and what to skip. When in doubt, persist.',
      'Set overwrite: true when replacing known state (hardware specs, config, user preferences). Use default append for new facts, fixes, and discoveries.',
    ],
    parameters: Type.Object({
      topic:    Type.String({ description: 'Topic name, e.g. "PostgreSQL Setup" or "Homelab Server"' }),
      content:  Type.String({ description: 'The content to write or append to the topic file' }),
      summary:  Type.String({ description: 'One-line summary for the MEMORY.md index entry' }),
      pin:      Type.Optional(Type.Boolean({ description: 'Pin this entry so it is never a cleanup candidate' })),
      mode:     Type.Optional(Type.Union([Type.Literal('append'), Type.Literal('replace')], { description: '"append" (default) adds content under a dated heading. "replace" overwrites the body, preserving frontmatter — use for state entries like hardware specs or config.' })),
    }),
    async execute(_toolCallId, params) {
      const text = await executeWriteMemory(params);
      return { content: [{ type: 'text', text }], details: {} };
    },
  });

  // ── remove_memory ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'remove_memory',
    label: 'Remove Memory',
    description:
      'Remove a memory index entry by topic name. ' +
      'Refuses if the entry is pinned. The topic file is preserved on disk.',
    parameters: Type.Object({
      topic: Type.String({ description: 'Topic name or partial match to remove' }),
    }),
    async execute(_toolCallId, params) {
      const text = await executeRemoveMemory(params);
      return { content: [{ type: 'text', text }], details: {} };
    },
  });

  // ── pin_memory ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'pin_memory',
    label: 'Pin Memory',
    description: 'Pin or unpin a memory index entry. Pinned entries are never cleanup candidates and never flagged as stale.',
    parameters: Type.Object({
      topic: Type.String({ description: 'Topic name or partial match to pin/unpin' }),
      pin:   Type.Boolean({ description: 'true to pin, false to unpin' }),
    }),
    async execute(_toolCallId, params) {
      const text = await executePinMemory(params);
      return { content: [{ type: 'text', text }], details: {} };
    },
  });

  // ── /memory command ───────────────────────────────────────────────────────

  pi.registerCommand('memory', {
    description: '/memory → show index | /memory <text> → store | /memory consolidate → extract session facts | /memory pin <topic> | /memory unpin <topic> | /memory remove <topic> | /memory search <query>',

    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // Confirmation overlay for destructive remove actions
      const confirmRemove = async (topic: string): Promise<boolean> => {
        const confirmed = await ctx.ui.custom<boolean>(
          (tui, theme, _kb, done) => {
            const title  = new Text(theme.fg('warning', theme.bold(`Remove "${topic}"?`)), 1, 0);
            const hint   = new Text(theme.fg('dim', 'The index entry is removed. The topic file is preserved on disk.'), 1, 0);
            const items: SelectItem[] = [
              { value: 'cancel',  label: 'Cancel' },
              { value: 'confirm', label: 'Yes, remove' },
            ];
            const list = new SelectList(items, items.length, {
              selectedPrefix: (t) => theme.fg('accent', t),
              selectedText:   (t) => theme.fg('accent', t),
              scrollInfo:     (t) => theme.fg('dim', t),
              noMatch:        (t) => theme.fg('warning', t),
            });
            list.onSelect = (item) => done(item.value === 'confirm');
            list.onCancel = () => done(false);
            const widget = borderedBox((s: string) => theme.fg('accent', s), [title, hint, new Spacer(1), list]);
            return {
              render:      (w: number) => widget.render(w),
              invalidate:  ()         => widget.invalidate(),
              handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
            };
          },
          { overlay: true },
        );
        return confirmed ?? false;
      };

      // ── shared interactive browser ─────────────────────────────────────
      // Accepts an ordered entry list and a title string.
      // Loops: pin/unpin and remove stay in the browser; esc exits.
      const browseEntries = async (initialEntries: ReturnType<typeof readIndexEntries>, browserTitle: string) => {
        let focusedIndex = 0;
        while (true) {
          // Re-read full index each iteration so mutations are reflected.
          // For filtered sets (search), remap by filename to pick up fresh pin/stale state.
          const all = readIndexEntries();
          const byFile = new Map(all.map(e => [e.filename, e]));
          const entries = initialEntries
            .map(e => byFile.get(e.filename))
            .filter((e): e is NonNullable<typeof e> => !!e);
          focusedIndex = Math.min(focusedIndex, Math.max(0, entries.length - 1));

          if (entries.length === 0) {
            ctx.ui.notify('No entries to display.', 'info');
            break;
          }

          // ── list view ────────────────────────────────────────────────────
          const listItems: SelectItem[] = entries.map(e => ({
            value:       e.name,
            label:       e.name,
            description: [e.date, e.pinned ? 'pinned' : '', e.stale ? 'stale' : ''].filter(Boolean).join(' · '),
          }));

          const listResult = await ctx.ui.custom<{ type: 'enter' | 'pin' | 'remove'; name: string } | null>(
            (tui, theme, _kb, done) => {
              const title  = new Text(theme.fg('accent', theme.bold(browserTitle)), 1, 0);
              const hint   = new Text(theme.fg('dim', '↑↓ navigate · enter view · [p]in/unpin · [r]emove · esc exit'), 1, 0);
              const list   = new SelectList(listItems, Math.min(listItems.length, 12), {
                selectedPrefix: (t) => theme.fg('accent', t),
                selectedText:   (t) => theme.fg('accent', t),
                description:    (t) => theme.fg('muted', t),
                scrollInfo:     (t) => theme.fg('dim', t),
                noMatch:        (t) => theme.fg('warning', t),
              });
              list.setSelectedIndex(focusedIndex);
              list.onSelect = (item) => done({ type: 'enter', name: item.value });
              list.onCancel = () => done(null);
              const widget = borderedBox((s: string) => theme.fg('accent', s), [title, list, hint]);
              return {
                render:      (w: number) => widget.render(w),
                invalidate:  ()         => widget.invalidate(),
                handleInput: (data: string) => {
                  if (matchesKey(data, 'p')) {
                    done({ type: 'pin', name: entries[focusedIndex]?.name ?? listItems[0].value });
                    return;
                  }
                  if (matchesKey(data, 'r')) {
                    done({ type: 'remove', name: entries[focusedIndex]?.name ?? listItems[0].value });
                    return;
                  }
                  if (matchesKey(data, 'up')   && focusedIndex > 0)                  focusedIndex--;
                  else if (matchesKey(data, 'down') && focusedIndex < entries.length - 1) focusedIndex++;
                  list.handleInput(data);
                  tui.requestRender();
                },
              };
            },
            { overlay: true },
          );

          if (!listResult) break; // Esc → exit

          const entry = entries.find(e => e.name === listResult.name)!;

          if (listResult.type === 'pin') {
            const result = await executePinMemory({ topic: entry.name, pin: !entry.pinned });
            ctx.ui.notify(result, 'info');
            continue;
          }

          if (listResult.type === 'remove') {
            if (await confirmRemove(entry.name)) {
              const result = await executeRemoveMemory({ topic: entry.name });
              ctx.ui.notify(result, result.toLowerCase().includes('pinned') ? 'warning' : 'info');
            }
            continue;
          }

          // ── detail view ──────────────────────────────────────────────────
          const body    = readTopicContent(entry.filename);
          const mdTheme = getMarkdownTheme();
          const PREVIEW_LINES = 6;
          const bodyLines = body.split('\n');
          const previewBody = bodyLines.length > PREVIEW_LINES
            ? bodyLines.slice(0, PREVIEW_LINES).join('\n') + `\n\n*… ${bodyLines.length - PREVIEW_LINES} more lines (${entry.filename})*`
            : body;

          const detailActions: SelectItem[] = [
            { value: 'pin',    label: entry.pinned ? 'un[p]in' : '[p]in' },
            { value: 'remove', label: '[r]emove' },
            { value: 'back',   label: 'Back' },
          ];

          const detailResult = await ctx.ui.custom<string | null>(
            (tui, theme, _kb, done) => {
              const words  = entry.name.split(' ');
              const displayName = words.length > 6 ? words.slice(0, 6).join(' ') + '…' : entry.name;
              const title  = new Text(theme.fg('accent', theme.bold(displayName)), 1, 0);
              const meta   = new Text(theme.fg('muted',
                [entry.summary, entry.date, entry.pinned ? 'pinned' : '', entry.stale ? 'stale' : '']
                  .filter(Boolean).join(' · ')
              ), 1, 0);
              const md   = new Markdown(previewBody, 1, 0, mdTheme);
              const list = new SelectList(detailActions, detailActions.length, {
                selectedPrefix: (t) => theme.fg('accent', t),
                selectedText:   (t) => theme.fg('accent', t),
                description:    (t) => theme.fg('dim', t),
                scrollInfo:     (t) => theme.fg('dim', t),
                noMatch:        (t) => theme.fg('warning', t),
              });
              list.onSelect = (item) => done(item.value);
              list.onCancel = () => done(null);
              const widget = borderedBox((s: string) => theme.fg('accent', s), [title, meta, md, new Spacer(1), list]);
              return {
                render:      (w: number) => widget.render(w),
                invalidate:  ()         => widget.invalidate(),
                handleInput: (data: string) => {
                  if (matchesKey(data, 'p')) { done('pin'); return; }
                  if (matchesKey(data, 'r')) { done('remove'); return; }
                  list.handleInput(data);
                  tui.requestRender();
                },
              };
            },
            { overlay: true, overlayOptions: { maxHeight: '85%' } },
          );

          if (detailResult === 'pin') {
            const result = await executePinMemory({ topic: entry.name, pin: !entry.pinned });
            ctx.ui.notify(result, 'info');
          } else if (detailResult === 'remove') {
            if (await confirmRemove(entry.name)) {
              const result = await executeRemoveMemory({ topic: entry.name });
              ctx.ui.notify(result, result.toLowerCase().includes('pinned') ? 'warning' : 'info');
            }
          }
          // 'back' / null / Esc → loop back to list
        }
      };

      // No args → interactive memory browser
      if (!trimmed) {
        const entries = readIndexEntries();
        if (entries.length === 0) {
          ctx.ui.notify('Memory index is empty. Use /memory <text> to store something.', 'info');
          return;
        }
        await browseEntries(entries, 'Memory');
        return;
      }

      // remove <topic>
      if (trimmed.toLowerCase().startsWith('remove ')) {
        const topic = trimmed.slice('remove '.length).trim();
        if (await confirmRemove(topic)) {
          const result = await executeRemoveMemory({ topic });
          ctx.ui.notify(result, result.toLowerCase().includes('pinned') ? 'warning' : 'info');
        }
        return;
      }

      // pin <topic>
      if (trimmed.toLowerCase().startsWith('pin ')) {
        const topic = trimmed.slice('pin '.length).trim();
        const result = await executePinMemory({ topic, pin: true });
        ctx.ui.notify(result, 'info');
        return;
      }

      // unpin <topic>
      if (trimmed.toLowerCase().startsWith('unpin ')) {
        const topic = trimmed.slice('unpin '.length).trim();
        const result = await executePinMemory({ topic, pin: false });
        ctx.ui.notify(result, 'info');
        return;
      }

      // search <query>
      if (trimmed.toLowerCase().startsWith('search ')) {
        const query = trimmed.slice('search '.length).trim();
        if (!query) {
          ctx.ui.notify('Usage: /memory search <query>', 'info');
          return;
        }
        const matches = searchMemory(query);
        if (matches.length === 0) {
          ctx.ui.notify(`No matches for "${query}"`, 'info');
          return;
        }
        // Map search results to full index entries (for pin/stale/date/summary state)
        const all = readIndexEntries();
        const byFile = new Map(all.map(e => [e.filename, e]));
        const entries = matches
          .map(m => byFile.get(m.filename))
          .filter((e): e is NonNullable<typeof e> => !!e);
        await browseEntries(entries, `Search: ${query}  (${entries.length} match${entries.length === 1 ? '' : 'es'})`);
        return;
      }

      // consolidate
      if (trimmed.toLowerCase() === 'consolidate') {
        if (!ctx.isIdle()) {
          ctx.ui.notify('Agent is busy — consolidation queued as follow-up.', 'info');
          pi.sendUserMessage(CONSOLIDATION_PROMPT, { deliverAs: 'followUp' });
          return;
        }
        pi.sendUserMessage(CONSOLIDATION_PROMPT);
        return;
      }

      // Any other text → ask agent to store it via write_memory
      if (!ctx.isIdle()) {
        ctx.ui.notify('Agent is busy — queued as follow-up.', 'info');
        pi.sendUserMessage(
          `Store the following as a memory entry. Decide the topic name, summary, and whether to pin it, then call write_memory:\n\n${trimmed}`,
          { deliverAs: 'followUp' },
        );
        return;
      }

      pi.sendUserMessage(
        `Store the following as a memory entry. Decide the topic name, summary, and whether to pin it, then call write_memory:\n\n${trimmed}`,
      );
    },
  });
}
