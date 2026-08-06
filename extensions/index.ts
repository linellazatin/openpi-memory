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
 *
 * Tools registered: write_memory, remove_memory, pin_memory
 * Command registered: /memory
 */

import { Type } from 'typebox';
import { DynamicBorder, getMarkdownTheme, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Container, Markdown, matchesKey, type SelectItem, SelectList, Spacer, Text } from '@earendil-works/pi-tui';
import {
  MEMORY_DIR,
  MEMORY_RULES,
  MAX_LINES,
  parseRules,
  renderRulesToMarkdown,
  readMemoryIndex,
  readIndexEntries,
  readTopicContent,
  executeWriteMemory,
  executeRemoveMemory,
  executePinMemory,
} from './memory-core.mjs';

// --- Injection state ---
// process-global; safe for single-user extension.
// Upgrade to per-session Map if multi-session support is needed.
let _injectedOnce = false;
let _turnCount = 0;

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

      if (!extra) return;
      return { systemPrompt: event.systemPrompt + extra };
    }
  });

  // ── session_before_compact ───────────────────────────────────────────────
  // Reset injection state so the first prompt after compaction always re-injects,
  // regardless of where the turn counter was before compaction.

  pi.on('session_before_compact', async () => {
    _injectedOnce = false;
    _turnCount = 0;
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
      overwrite: Type.Optional(Type.Boolean({ description: 'true = replace the full topic body with this content (use for state entries like hardware specs or config); false (default) = append under a new date heading (use for logs, fixes, discoveries)' })),
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
    description: '/memory → show index | /memory <text> → store | /memory pin <topic> | /memory unpin <topic> | /memory remove <topic>',

    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // Confirmation overlay for destructive remove actions
      const confirmRemove = async (topic: string): Promise<boolean> => {
        const confirmed = await ctx.ui.custom<boolean>(
          (tui, theme, _kb, done) => {
            const border = new DynamicBorder((s: string) => theme.fg('accent', s));
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
            const container = new Container();
            container.addChild(border);
            container.addChild(title);
            container.addChild(hint);
            container.addChild(new Spacer(1));
            container.addChild(list);
            container.addChild(border);
            return {
              render:      (w: number) => container.render(w),
              invalidate:  ()         => container.invalidate(),
              handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
            };
          },
          { overlay: true },
        );
        return confirmed ?? false;
      };

      // No args → interactive memory browser (loops until user exits with Esc)
      if (!trimmed) {
        while (true) {
          const entries = readIndexEntries();

          if (entries.length === 0) {
            ctx.ui.notify('Memory index is empty. Use /memory <text> to store something.', 'info');
            break;
          }

          // ── list view ────────────────────────────────────────────────────
          const listItems: SelectItem[] = entries.map(e => ({
            value:       e.name,
            label:       e.name,
            description: [e.date, e.pinned ? 'pinned' : '', e.stale ? 'stale' : ''].filter(Boolean).join(' · '),
          }));

          let focusedIndex = 0;

          const listResult = await ctx.ui.custom<{ type: 'enter' | 'pin'; name: string } | null>(
            (tui, theme, _kb, done) => {
              const border = new DynamicBorder((s: string) => theme.fg('accent', s));
              const title  = new Text(theme.fg('accent', theme.bold('Memory')), 1, 0);
              const hint   = new Text(theme.fg('dim', '↑↓ navigate · enter view · p pin/unpin · esc exit'), 1, 0);
              const list   = new SelectList(listItems, Math.min(listItems.length, 12), {
                selectedPrefix: (t) => theme.fg('accent', t),
                selectedText:   (t) => theme.fg('accent', t),
                description:    (t) => theme.fg('muted', t),
                scrollInfo:     (t) => theme.fg('dim', t),
                noMatch:        (t) => theme.fg('warning', t),
              });
              list.onSelect = (item) => done({ type: 'enter', name: item.value });
              list.onCancel = () => done(null);
              const container = new Container();
              container.addChild(border);
              container.addChild(title);
              container.addChild(list);
              container.addChild(hint);
              container.addChild(border);
              return {
                render:      (w: number) => container.render(w),
                invalidate:  ()         => container.invalidate(),
                handleInput: (data: string) => {
                  if (matchesKey(data, 'p')) {
                    done({ type: 'pin', name: entries[focusedIndex]?.name ?? listItems[0].value });
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

          if (!listResult) break; // Esc → exit browser

          const entry = entries.find(e => e.name === listResult.name)!;

          // p from list → immediate pin/unpin, stay in browser
          if (listResult.type === 'pin') {
            const result = await executePinMemory({ topic: entry.name, pin: !entry.pinned });
            ctx.ui.notify(result, 'info');
            continue;
          }

          // ── detail view ──────────────────────────────────────────────────
          const body    = readTopicContent(entry.filename);
          const mdTheme = getMarkdownTheme();

          const detailActions: SelectItem[] = [
            { value: 'pin',    label: entry.pinned ? 'Unpin' : 'Pin', description: 'p' },
            { value: 'remove', label: 'Remove' },
            { value: 'back',   label: 'Back' },
          ];

          const detailResult = await ctx.ui.custom<string | null>(
            (tui, theme, _kb, done) => {
              const border = new DynamicBorder((s: string) => theme.fg('accent', s));
              const title  = new Text(theme.fg('accent', theme.bold(entry.name)), 1, 0);
              const meta   = new Text(theme.fg('muted',
                [entry.summary, entry.date, entry.pinned ? 'pinned' : '', entry.stale ? 'stale' : '']
                  .filter(Boolean).join(' · ')
              ), 1, 0);
              const md   = new Markdown(body, 1, 0, mdTheme);
              const list = new SelectList(detailActions, detailActions.length, {
                selectedPrefix: (t) => theme.fg('accent', t),
                selectedText:   (t) => theme.fg('accent', t),
                description:    (t) => theme.fg('dim', t),
                scrollInfo:     (t) => theme.fg('dim', t),
                noMatch:        (t) => theme.fg('warning', t),
              });
              list.onSelect = (item) => done(item.value);
              list.onCancel = () => done(null);
              const container = new Container();
              container.addChild(border);
              container.addChild(title);
              container.addChild(meta);
              container.addChild(md);
              container.addChild(new Spacer(1));
              container.addChild(list);
              container.addChild(border);
              return {
                render:      (w: number) => container.render(w),
                invalidate:  ()         => container.invalidate(),
                handleInput: (data: string) => {
                  if (matchesKey(data, 'p')) { done('pin'); return; }
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
