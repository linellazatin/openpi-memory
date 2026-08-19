/**
 * memory-core.mjs
 *
 * Platform-agnostic memory logic. No pi imports — importable by both the
 * extension (via jiti) and the smoke test (plain node).
 *
 * Storage paths respect two env overrides (both set before importing this module):
 *   PI_CODING_AGENT_DIR    — pi's own config-dir override (fixed at load time).
 *   PI_SHARED_MEMORY_HOME  — override for the shared-dir home root (test isolation only;
 *                            defaults to the real os.homedir()).
 *
 * The memory index/topic-file directory is NOT fixed at load time — it depends on the
 * `shared_dir` flag inside memory.jsonc, so it is resolved fresh via getMemoryDir() on
 * every call. MEMORY_RULES (config path) and HANDOFF_FILE are fixed, pi-specific paths
 * that never move regardless of shared_dir.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Storage paths ---

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
const SHARED_HOME_DIR = process.env.PI_SHARED_MEMORY_HOME ?? os.homedir();

// Legacy/default: index + topic files live in the legacy memory directory.
const LEGACY_MEMORY_DIR = path.join(AGENT_DIR, 'memory');
// Shared: index + topic files move here when shared_dir: true, so other tools
// (e.g. openclaude-memory/opencode) reading the same format can see them too.
const SHARED_MEMORY_DIR = path.join(SHARED_HOME_DIR, '.agents', 'memory');

// Config file: renamed from RULES.jsonc, relocated one level up out of memory/.
// Fixed, pi-specific — never affected by shared_dir.
export const MEMORY_RULES = path.join(AGENT_DIR, 'memory.jsonc');
const LEGACY_MEMORY_RULES = path.join(LEGACY_MEMORY_DIR, 'RULES.jsonc');
const LEGACY_MEMORY_RULES_BACKUP = path.join(LEGACY_MEMORY_DIR, 'RULES.jsonc.bak');

// HANDOFF.md is a pi-only compaction artifact — always local, sibling of memory.jsonc.
export const HANDOFF_FILE = path.join(AGENT_DIR, 'HANDOFF.md');


// --- Constants ---

export const MAX_LINES = 300;
export const MAX_BYTES = 50 * 1024;
export const DEFAULT_STALE_DAYS     = 180;
export const DEFAULT_INJECT_INTERVAL = 5;
export const DEFAULT_HANDOFF_KEEP   = 3;
export const DEFAULT_AUTO_RESUME_AFTER_THRESHOLD = false;
export const DEFAULT_CONSOLIDATE_ON_COMPACT = false;
export const DEFAULT_SHARED_DIR = false;
const LOCK_STALE_MS = 10 * 1000;
let _carryOverChecked = false; // guard: run carry-over at most once per process
const CARRY_OVER_SENTINEL = path.join(LEGACY_MEMORY_DIR, '.shared-dir-migrated');

// Single source of truth for parseRules()' fallback values — used both when a field is
// missing/invalid in memory.jsonc and when the whole file fails to read/parse.
const DEFAULT_RULES = {
  alwaysPersist: [],
  neverPersist: [],
  alwaysAsk: [],
  maxLines: MAX_LINES,
  staleAfterDays: DEFAULT_STALE_DAYS,
  injectEveryNTurns: DEFAULT_INJECT_INTERVAL,
  handoffKeep: DEFAULT_HANDOFF_KEEP,
  autoResumeAfterThreshold: DEFAULT_AUTO_RESUME_AFTER_THRESHOLD,
  consolidateOnCompact: DEFAULT_CONSOLIDATE_ON_COMPACT,
  sharedDir: DEFAULT_SHARED_DIR,
};

/**
 * Prompt sent to the agent by /memory consolidate and compaction_end consolidation path.
 * Instructs the agent to extract undocumented facts from the conversation and persist them,
 * then write a last-session-recap entry to orient the next session.
 */
const CONSOLIDATION_BODY =
`Focus on:
- Facts, configurations, or environment details learned
- Decisions made and the reasoning behind them
- Issues solved and how they were resolved
- Reusable commands, workflows, or patterns discovered
- User preferences stated explicitly

Skip anything already present in the ## Global Memory index, anything ephemeral or session-specific, and large code blocks (summarize or reference the file path instead).

As a final step, call write_memory with topic "last-session-recap", mode "replace", and pin false. Write a 3-5 sentence narrative summary of what was accomplished this session — this entry will be injected at the start of the next session to orient you quickly.`;

export const CONSOLIDATION_PROMPT =
`Review our conversation history and identify anything worth preserving across sessions that has not been written to memory yet. For each item, call write_memory with an appropriate topic, content, summary, and mode.

${CONSOLIDATION_BODY}`;

/**
 * Build a targeted consolidation prompt from a pre-generated compaction summary.
 * Cheaper than CONSOLIDATION_PROMPT: skips the full conversation scan — the summary
 * is already compressed and comprehensive.
 */
export function buildCompactionConsolidationPrompt(summary) {
  return `The following is the session summary pi just generated during compaction:\n\n${summary}\n\nUsing this summary, extract anything worth preserving across sessions that has not been written to memory yet. For each item, call write_memory with an appropriate topic, content, summary, and mode.\n\n${CONSOLIDATION_BODY}`;
}

// --- Initial file content ---

export const INITIAL_MEMORY = '# Memory Index\n\n';

export const INITIAL_RULES_JSONC = `{
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
  // Always ask before persisting these (non-overridable)
  "always_ask": [
    "Credentials, tokens, API keys",
    "Personal data",
    "Anything the user marks as private or ephemeral"
  ],
  // max_lines: valid range 50–1000
  "max_lines": 300,
  // stale_after_days: 0 = disable age flagging
  "stale_after_days": 180,
  // inject_every_n_turns: re-inject memory every N user prompts; 1 = every prompt
  "inject_every_n_turns": 5,
  // handoff_keep: number of past compaction handoffs to retain in HANDOFF.md; 0 = disable
  "handoff_keep": 3,
  // auto_resume_after_threshold_compaction: send "Continue." after threshold compaction; false = off
  "auto_resume_after_threshold_compaction": false,
  // consolidate_on_compact: run /memory consolidate after threshold compaction instead of plain "Continue."; false = off
  "consolidate_on_compact": false,
  // shared_dir: redirect the memory INDEX and TOPIC FILES to ~/.agents/memory/, a location
  // shared across tools (e.g. openclaude-memory/opencode). Does NOT affect where this config
  // file itself lives — config always stays per-tool. false = keep the current per-tool location.
  "shared_dir": false
}
`;

// --- Directory resolution ---

/**
 * One-time merge carry-over: when shared_dir first resolves true, merge local index + topic
 * files into the shared directory. If the shared dir already has content (written by another
 * tool), missing entries are appended and missing topic files are copied — never overwriting
 * what's already there. Filename collisions with differing content are resolved by a -opim
 * suffix. Runs at most once per process, gated by _carryOverChecked.
 */
function maybeCarryOverLocalMemory() {
  if (_carryOverChecked) return;
  _carryOverChecked = true;
  if (fs.existsSync(CARRY_OVER_SENTINEL)) return; // already merged in a prior process run
  if (!fs.existsSync(path.join(LEGACY_MEMORY_DIR, 'MEMORY.md'))) return; // nothing local to carry over
  try {
    fs.mkdirSync(SHARED_MEMORY_DIR, { recursive: true });
    // ponytail: no lock here — carry-over is one-time (_carryOverChecked gates it) and
    // additive-only; any race-condition duplicates are cleaned by maintainIndex on next write.
    mergeLocalIntoSharedDir(SHARED_MEMORY_DIR);
    fs.writeFileSync(CARRY_OVER_SENTINEL, ''); // mark complete so future process starts skip the full pass
  } catch {
    // best-effort — carry-over failure must never break normal operation
  }
}

// Merge local MEMORY.md entries and topic files into sharedDir.
// Appends only entries whose topic file is absent in the shared dir (by content or name).
// Never modifies or deletes anything already present in sharedDir.
function mergeLocalIntoSharedDir(sharedDir) {
  const sharedIndexPath = path.join(sharedDir, 'MEMORY.md');
  const sharedRaw = fs.existsSync(sharedIndexPath)
    ? fs.readFileSync(sharedIndexPath, 'utf8')
    : INITIAL_MEMORY;
  const sharedFilesOnDisk = new Set(fs.readdirSync(sharedDir));

  const localLines = fs.readFileSync(path.join(LEGACY_MEMORY_DIR, 'MEMORY.md'), 'utf8').split('\n');
  const toAppend = [];

  for (const line of localLines) {
    const parsed = parseIndexLine(line);
    if (!parsed) continue; // headers/blanks — destination keeps its own structure
    const srcPath = path.join(LEGACY_MEMORY_DIR, parsed.filename);
    if (!fs.existsSync(srcPath)) continue; // orphaned local entry — skip

    const destName = resolveDestName(srcPath, sharedDir, parsed.filename, sharedFilesOnDisk);
    if (destName === null) continue; // identical content already present — no-op

    atomicWriteFileSync(path.join(sharedDir, destName), fs.readFileSync(srcPath, 'utf8'));
    sharedFilesOnDisk.add(destName);
    toAppend.push(line.replace(`](${parsed.filename})`, `](${destName})`));
  }

  if (toAppend.length) {
    const merged = sharedRaw.trimEnd() + '\n' + toAppend.join('\n') + '\n';
    atomicWriteFileSync(sharedIndexPath, merged);
  } else if (!fs.existsSync(sharedIndexPath)) {
    atomicWriteFileSync(sharedIndexPath, sharedRaw); // shared dir is empty and local had no valid entries
  }
}

// Decide where a local topic file lands in sharedDir.
// Returns the destination filename, or null if the content is already present (no-op).
function resolveDestName(srcPath, sharedDir, filename, sharedFilesOnDisk) {
  const originalDest = path.join(sharedDir, filename);
  if (!fs.existsSync(originalDest)) return filename; // no collision

  if (filesEqual(srcPath, originalDest)) return null; // already there, identical

  const suffixed = filename.replace(/\.md$/, '-opim.md');
  const suffixedDest = path.join(sharedDir, suffixed);
  if (!fs.existsSync(suffixedDest)) return suffixed;
  if (filesEqual(srcPath, suffixedDest)) return null; // already migrated in a prior run

  // Exceedingly rare: both slots taken by different content — bump a counter.
  let n = 2, candidate;
  do { candidate = filename.replace(/\.md$/, `-opim-${n}.md`); n++; }
  while (sharedFilesOnDisk.has(candidate));
  return candidate;
}

function filesEqual(pathA, pathB) {
  return fs.readFileSync(pathA, 'utf8') === fs.readFileSync(pathB, 'utf8');
}

// Test-only: reset the carry-over guard to simulate a fresh process start.
export function _resetCarryOver() {
  _carryOverChecked = false;
  try { fs.unlinkSync(CARRY_OVER_SENTINEL); } catch { /* not present is fine */ }
}

/**
 * Resolve the active memory directory (index + topic files) based on the shared_dir config
 * flag. MEMORY_RULES (config path) and HANDOFF_FILE are NOT affected by this — only the
 * index/topic-file location moves.
 */
export function getMemoryDir() {
  const { sharedDir } = parseRules();
  if (sharedDir) {
    maybeCarryOverLocalMemory();
    return SHARED_MEMORY_DIR;
  }
  return LEGACY_MEMORY_DIR;
}

export function getMemoryIndex() {
  return path.join(getMemoryDir(), 'MEMORY.md');
}



/**
 * Write a file atomically: write to a temp file in the same directory, then rename over the
 * target. fs.renameSync is atomic on the same filesystem, so readers never observe a partial
 * write even if the process crashes or the write races with another writer.
 */
function atomicWriteFileSync(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// --- Config (memory.jsonc) ---

/**
 * Read and parse memory.jsonc. Creates the file with defaults if missing.
 * If the legacy RULES.jsonc (under the old memory/ dir) exists but memory.jsonc does not,
 * back it up (RULES.jsonc.bak) and copy its content forward — the legacy file is never
 * deleted or moved.
 * Strips // line comments and trailing commas before JSON.parse.
 * Clamps all scalar values to valid ranges.
 */
export function parseRules() {
  try {
    if (!fs.existsSync(MEMORY_RULES)) {
      fs.mkdirSync(AGENT_DIR, { recursive: true });
      if (fs.existsSync(LEGACY_MEMORY_RULES)) {
        // Same rationale as the shared_dir carry-over backup: this copy never touches
        // LEGACY_MEMORY_RULES, so the backup isn't strictly needed to prevent data loss here —
        // it's a deliberate safety net against a future code change, kept intentionally.
        if (!fs.existsSync(LEGACY_MEMORY_RULES_BACKUP)) {
          fs.copyFileSync(LEGACY_MEMORY_RULES, LEGACY_MEMORY_RULES_BACKUP);
        }
        fs.copyFileSync(LEGACY_MEMORY_RULES, MEMORY_RULES);
      } else {
        fs.writeFileSync(MEMORY_RULES, INITIAL_RULES_JSONC, 'utf8');
      }
    }
    const raw = fs.readFileSync(MEMORY_RULES, 'utf8');
    const stripped = raw
      .replace(/\/\/[^\n]*/g, '')
      .replace(/,\s*([}\]])/g, '$1');
    const obj = JSON.parse(stripped);

    return {
      alwaysPersist: Array.isArray(obj.always_persist) ? obj.always_persist : DEFAULT_RULES.alwaysPersist,
      neverPersist:  Array.isArray(obj.never_persist)  ? obj.never_persist  : DEFAULT_RULES.neverPersist,
      alwaysAsk:     Array.isArray(obj.always_ask)     ? obj.always_ask     : DEFAULT_RULES.alwaysAsk,
      maxLines:          Math.min(1000, Math.max(50,  typeof obj.max_lines           === 'number' ? obj.max_lines           : DEFAULT_RULES.maxLines)),
      staleAfterDays:    Math.max(0,               typeof obj.stale_after_days     === 'number' ? obj.stale_after_days     : DEFAULT_RULES.staleAfterDays),
      injectEveryNTurns: Math.max(1,               typeof obj.inject_every_n_turns  === 'number' ? obj.inject_every_n_turns  : DEFAULT_RULES.injectEveryNTurns),
      handoffKeep:       Math.max(0,               typeof obj.handoff_keep          === 'number' ? obj.handoff_keep          : DEFAULT_RULES.handoffKeep),
      autoResumeAfterThreshold: typeof obj.auto_resume_after_threshold_compaction === 'boolean' ? obj.auto_resume_after_threshold_compaction : DEFAULT_RULES.autoResumeAfterThreshold,
      consolidateOnCompact: typeof obj.consolidate_on_compact === 'boolean' ? obj.consolidate_on_compact : DEFAULT_RULES.consolidateOnCompact,
      sharedDir: typeof obj.shared_dir === 'boolean' ? obj.shared_dir : DEFAULT_RULES.sharedDir,
    };
  } catch {
    return { ...DEFAULT_RULES };
  }
}

/**
 * Render parsed rules to markdown for system prompt injection.
 * Config scalars (max_lines, stale_after_days, inject_every_n_turns, handoff_keep, auto_resume_after_threshold_compaction, consolidate_on_compact, shared_dir) are
 * never rendered — they are consumed by the extension, not the LLM.
 */
export function renderRulesToMarkdown(rules) {
  const parts = [];

  if (rules.alwaysPersist.length > 0) {
    parts.push('## Always persist\n' + rules.alwaysPersist.map(s => `- ${s}`).join('\n'));
  }
  if (rules.neverPersist.length > 0) {
    parts.push('## Never persist\n' + rules.neverPersist.map(s => `- ${s}`).join('\n'));
  }
  if (rules.alwaysAsk.length > 0) {
    parts.push('## Always ask before persisting\n' + rules.alwaysAsk.map(s => `- ${s}`).join('\n'));
  }

  return parts.join('\n\n');
}

// --- Compaction handoff ---

/**
 * Detect whether handoff content suggests an incomplete task.
 * Looks for keywords indicating continuation needs.
 */
export function detectIncompleteTask(handoffText) {
  const lower = handoffText.toLowerCase();
  const keywords = [
    /need to/i,
    /should/i,
    /waiting for/i,
    /pending/i,
    /next/i,
    /then/i,
    /not done/i,
    /incomplete/i,
    /unfinished/i,
  ];
  for (const kw of keywords) {
    if (kw.test(lower)) return true;
  }
  return false;
}

// --- File I/O helpers ---

/**
 * Read MEMORY.md, truncating if over maxLines or MAX_BYTES.
 * Creates the file with INITIAL_MEMORY if missing.
 */
export function readMemoryIndex(maxLines) {
  try {
    const memoryDir = getMemoryDir();
    const memoryIndex = path.join(memoryDir, 'MEMORY.md');
    if (!fs.existsSync(memoryIndex)) {
      fs.mkdirSync(memoryDir, { recursive: true });
      atomicWriteFileSync(memoryIndex, INITIAL_MEMORY);
      return INITIAL_MEMORY;
    }
    const raw = fs.readFileSync(memoryIndex, 'utf8');
    const lines = raw.split('\n');
    if (Buffer.byteLength(raw) > MAX_BYTES) {
      const truncated = lines.slice(0, maxLines).join('\n');
      return truncated + `\n\n<!-- memory truncated: MEMORY.md exceeds size limit; shorten the index -->`;
    }
    if (lines.length > maxLines) {
      const truncated = lines.slice(0, maxLines).join('\n');
      return truncated + `\n\n<!-- memory truncated: MEMORY.md exceeds ${maxLines}-line limit; shorten the index -->`;
    }
    return raw;
  } catch {
    return null;
  }
}

// --- Index line helpers ---

/**
 * Parse a MEMORY.md index line.
 * Format: - [Topic Name](file.md) [pin] YYYY-MM-DD [stale?] -- summary
 * Returns null for non-entry lines (headings, blanks, etc.).
 */
export function parseIndexLine(line) {
  const match = line.match(/^(\s*-\s+\[)([^\]]+)(\]\()([^)]+)(\))(.*)/);
  if (!match) return null;
  return {
    prefix:   match[1],
    name:     match[2],
    mid:      match[3] + match[4] + match[5],
    filename: match[4],
    rest:     match[6],
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Returns current local datetime as ISO 8601 with host timezone offset: 2026-08-06T23:15:30+08:00
function nowIso() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const offsetMins = -d.getTimezoneOffset(); // getTimezoneOffset() is inverted
  const sign = offsetMins >= 0 ? '+' : '-';
  const absM = Math.abs(offsetMins);
  const tz = `${sign}${pad(Math.floor(absM / 60))}:${pad(absM % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`
  );
}

/**
 * Update (or insert) the last_updated field in YAML frontmatter.
 * Frontmatter is the block between the opening --- and closing ---.
 * Inserts after the created: line if last_updated is not yet present.
 */
function updateFrontmatterLastUpdated(fileContent, datetime) {
  const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return fileContent;

  let fm = fmMatch[1];
  const rest = fileContent.slice(fmMatch[0].length);

  if (fm.includes('last_updated:')) {
    fm = fm.replace(/^last_updated:.*$/m, `last_updated: ${datetime}`);
  } else {
    fm = fm.replace(/^(created:.*)$/m, `$1\nlast_updated: ${datetime}`);
  }

  return `---\n${fm}\n---\n${rest}`;
}

function daysSince(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

export function toSlug(topic) {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Upsert a line in the index by filename. Appends if not found.
 * Preserves existing pin status when updating.
 */
export function upsertIndexLine(lines, filename, name, summary, pin) {
  const dateStr = nowIso();
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseIndexLine(lines[i]);
    if (!parsed || parsed.filename !== filename) continue;
    const effectivePin = parsed.rest.includes('[pin]') || pin;
    const pinToken = effectivePin ? ' [pin]' : '';
    lines[i] = `- [${name}](${filename})${pinToken} ${dateStr} -- ${summary}`;
    return lines;
  }
  // New entry
  const pinToken = pin ? ' [pin]' : '';
  lines.push(`- [${name}](${filename})${pinToken} ${dateStr} -- ${summary}`);
  return lines;
}

/**
 * Maintain index integrity: remove orphaned entries (topic file deleted),
 * deduplicate by filename (keep newest date), stamp/heal [stale?].
 * Runs after every mutating tool call — never on read.
 */
export function maintainIndex(lines, config, memoryDir = getMemoryDir()) {
  const { staleAfterDays } = config;

  // Pass 1: build Map<filename, {line, rest, parsed, idx}> — most-recent date wins, orphans excluded.
  const ISO_DATE_RE = /(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})?)/;
  const best = new Map();
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseIndexLine(lines[i]);
    if (!parsed) continue;
    const { filename } = parsed;
    if (!fs.existsSync(path.join(memoryDir, filename))) continue; // orphan
    const thisDate = (parsed.rest.match(ISO_DATE_RE) ?? [])[1] ?? '';
    const existing = best.get(filename);
    if (!existing) {
      best.set(filename, { line: lines[i], rest: parsed.rest, parsed, idx: i });
    } else {
      const existDate = (existing.rest.match(ISO_DATE_RE) ?? [])[1] ?? '';
      if (thisDate > existDate) best.set(filename, { line: lines[i], rest: parsed.rest, parsed, idx: i });
    }
  }

  // Pass 2: rebuild in original order — emit best entry once, apply stale stamping.
  const emitted = new Set();
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseIndexLine(lines[i]);
    if (!parsed) { result.push(lines[i]); continue; }
    const { filename } = parsed;
    if (!best.has(filename)) continue;       // orphan
    if (emitted.has(filename)) continue;     // duplicate — skip
    if (best.get(filename).idx !== i) continue; // not the best occurrence
    emitted.add(filename);

    let rest = parsed.rest;
    const isPinned = rest.includes('[pin]');
    if (!isPinned && staleAfterDays > 0) {
      const dateMatch = rest.match(ISO_DATE_RE);
      if (dateMatch) {
        const age = daysSince(dateMatch[1]);
        if (age !== null && age > staleAfterDays) {
          if (!rest.includes('[stale?]')) rest = rest.replace(dateMatch[1], `${dateMatch[1]} [stale?]`);
        } else {
          rest = rest.replace(' [stale?]', '');
        }
      }
    }
    result.push(parsed.prefix + parsed.name + parsed.mid + rest);
  }

  return result;
}

/**
 * Find the first index entry whose name or filename matches the search string
 * (case-insensitive, substring match).
 */
function findIndexEntry(lines, search) {
  const s = search.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseIndexLine(lines[i]);
    if (!parsed) continue;
    if (parsed.name.toLowerCase().includes(s) || parsed.filename.toLowerCase().includes(s))
      return { idx: i, parsed };
  }
  return null;
}

/**
 * Search the index and topic file bodies for a case-insensitive substring.
 * Returns matches as { name, filename, matchType: 'index'|'body', snippet }.
 * Index matches take priority; a topic that matched the index is not also
 * returned as a body match.
 */
export function searchMemory(query) {
  const q = query.toLowerCase();
  const results = [];
  const indexedNames = new Set();

  // (a) index — name, filename, summary
  for (const entry of readIndexEntries()) {
    if (
      entry.name.toLowerCase().includes(q) ||
      entry.filename.toLowerCase().includes(q) ||
      entry.summary.toLowerCase().includes(q)
    ) {
      const snippet = entry.summary || entry.name;
      results.push({ name: entry.name, filename: entry.filename, matchType: 'index', snippet });
      indexedNames.add(entry.filename);
    }
  }

  // (b) topic file bodies — skip files already matched via index
  const SKIP = new Set(['MEMORY.md']);
  const memoryDir = getMemoryDir();
  if (!fs.existsSync(memoryDir)) return results;
  for (const file of fs.readdirSync(memoryDir)) {
    if (!file.endsWith('.md')) continue;
    if (SKIP.has(file) || indexedNames.has(file)) continue;
    const filePath = path.join(memoryDir, file);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (line.toLowerCase().includes(q)) {
        const snippet = line.trim().slice(0, 120);
        results.push({ name: file.replace(/\.md$/, ''), filename: file, matchType: 'body', snippet });
        break; // first matching line per file
      }
    }
  }

  return results;
}

// --- Concurrency ---

/**
 * Cross-process advisory file lock. A single in-process mutex is not enough once the
 * memory dir can be shared with other tools/processes (shared_dir: true). Acquires by
 * atomically creating a `.lock` file (fails if it already exists); a lock older than
 * LOCK_STALE_MS is assumed abandoned by a crashed process and is stolen.
 */
async function acquireLock(lockPath) {
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {
        continue; // lock file vanished between our check and stat — retry immediately
      }
      await new Promise(r => setTimeout(r, 20));
    }
  }
}

async function withLock(fn) {
  const memoryDir = getMemoryDir();
  fs.mkdirSync(memoryDir, { recursive: true });
  const lockPath = path.join(memoryDir, '.lock');
  await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

// --- Tool execute functions ---
// Called by both pi tools (index.ts) and /memory command handler directly.

export async function executeWriteMemory({ topic, content, summary, pin = false, mode = 'append', overwrite }) {
  // backwards compat: overwrite: true maps to mode: 'replace'
  const replace = mode === 'replace' || overwrite === true;
  return withLock(() => {
    const memoryDir = getMemoryDir();
    const memoryIndex = path.join(memoryDir, 'MEMORY.md');
    fs.mkdirSync(memoryDir, { recursive: true });

    // Read index once — reused for topic-name lookup and upsert
    const rawIndex = fs.existsSync(memoryIndex)
      ? fs.readFileSync(memoryIndex, 'utf8')
      : INITIAL_MEMORY;

    // Prefer existing filename if the topic is already indexed (avoids slug drift)
    let filename = toSlug(topic) + '.md';
    for (const line of rawIndex.split('\n')) {
      const parsed = parseIndexLine(line);
      if (parsed && parsed.name.toLowerCase() === topic.toLowerCase()) {
        filename = parsed.filename;
        break;
      }
    }
    const topicPath = path.join(memoryDir, filename);

    let isNew = false;
    const dt = nowIso();
    if (!fs.existsSync(topicPath)) {
      isNew = true;
      const frontmatter =
        `---\nname: ${topic}\ndescription: ${summary}\ncreated: ${dt}\nlast_updated: ${dt}\nmetadata:\n  node_type: memory\n---\n\n`;
      atomicWriteFileSync(topicPath, frontmatter + content + '\n');
    } else if (replace) {
      // Replace body content; preserve frontmatter and update last_updated
      const existing = fs.readFileSync(topicPath, 'utf8');
      const updated = updateFrontmatterLastUpdated(existing, dt);
      // Strip everything after the closing frontmatter --- and replace with new content
      const bodyStart = updated.indexOf('---\n', 4) + 4; // skip past the closing ---
      atomicWriteFileSync(topicPath, updated.slice(0, bodyStart) + '\n' + content + '\n');
    } else {
      const existing = fs.readFileSync(topicPath, 'utf8');
      const updated = updateFrontmatterLastUpdated(existing, dt);
      atomicWriteFileSync(topicPath, updated + `\n## ${today()}\n\n` + content + '\n');
    }

    let lines = rawIndex.split('\n');
    lines = upsertIndexLine(lines, filename, topic, summary, pin);
    lines = maintainIndex(lines, parseRules(), memoryDir);
    atomicWriteFileSync(memoryIndex, lines.join('\n'));

    return `${isNew ? 'Created' : 'Updated'} memory topic "${topic}" (${filename}).`;
  });
}

export async function executeRemoveMemory({ topic }) {
  return withLock(() => {
    const memoryIndex = getMemoryIndex();
    if (!fs.existsSync(memoryIndex)) return 'No memory index found.';

    const lines = fs.readFileSync(memoryIndex, 'utf8').split('\n');
    const found = findIndexEntry(lines, topic);

    if (!found) return `No entry found matching "${topic}".`;

    if (found.parsed.rest.includes('[pin]'))
      return `Cannot remove "${found.parsed.name}" — it is pinned. Unpin it first with: /memory unpin ${topic}`;

    lines.splice(found.idx, 1);
    atomicWriteFileSync(memoryIndex, lines.join('\n'));
    return `Removed "${found.parsed.name}" from the index. Topic file is preserved on disk.`;
  });
}

export async function executePinMemory({ topic, pin }) {
  return withLock(() => {
    const memoryIndex = getMemoryIndex();
    if (!fs.existsSync(memoryIndex)) return 'No memory index found.';

    const lines = fs.readFileSync(memoryIndex, 'utf8').split('\n');
    const found = findIndexEntry(lines, topic);

    if (!found) return `No entry found matching "${topic}".`;

    const { idx, parsed } = found;
    const before = lines[idx];
    const isCurrentlyPinned = lines[idx].includes('[pin]');

    if (pin === isCurrentlyPinned)
      return `"${parsed.name}" is already ${pin ? 'pinned' : 'unpinned'}.`;

    if (pin) {
      // Insert [pin] immediately after the closing ) of the markdown link
      lines[idx] = lines[idx].replace(/(\]\([^)]+\))/, '$1 [pin]');
    } else {
      lines[idx] = lines[idx].replace(' [pin]', '');
    }

    atomicWriteFileSync(memoryIndex, lines.join('\n'));
    return `${pin ? 'Pinned' : 'Unpinned'} "${parsed.name}".\nBefore: ${before}\n After: ${lines[idx]}`;
  });
}

// --- Compaction handoff ---

/**
 * Extract the last N assistant text messages from a messagesToSummarize array,
 * format as terse bullet points, and append a dated entry to HANDOFF.md.
 * Prunes the file to retain only the last `handoffKeep` entries.
 */
export function writeHandoff(messages, reason, handoffKeep = DEFAULT_HANDOFF_KEEP) {
  if (handoffKeep === 0) return;

  // Collect assistant text blocks (skip thinking, tool calls, non-assistant roles)
  const textBlocks = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const text = msg.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('')
      .trim();
    if (text) textBlocks.push(text);
  }

  if (textBlocks.length === 0) return;

  // Take the last 3 assistant messages (closest to the compaction cut point)
  const tail = textBlocks.slice(-3);

  // Convert each block to bullet lines: drop blanks, fences, pure headers
  const MAX_BULLETS = 15;
  const bullets = [];
  for (const block of tail) {
    for (const raw of block.split('\n')) {
      if (bullets.length >= MAX_BULLETS) break;
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('```')) continue;
      if (/^#{1,6}\s/.test(line)) continue;  // markdown headers
      bullets.push('- ' + line.replace(/^[-*]\s+/, '').replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1'));
    }
  }

  if (bullets.length === 0) return;

  const entry = `## ${nowIso()} (${reason})\n\n${bullets.join('\n')}\n`;

  // One-time migration: if new path doesn't exist but old path does, copy content forward.
  // Old file stays on disk (never deleted), becomes inert.
  const oldHandoffPath = path.join(LEGACY_MEMORY_DIR, 'HANDOFF.md');
  if (!fs.existsSync(HANDOFF_FILE) && fs.existsSync(oldHandoffPath)) {
    fs.copyFileSync(oldHandoffPath, HANDOFF_FILE);
  }
  const existing = fs.existsSync(HANDOFF_FILE) ? fs.readFileSync(HANDOFF_FILE, 'utf8') : '';
  const updated = existing + (existing.endsWith('\n') || !existing ? '' : '\n') + '\n' + entry;

  // Prune: keep only the last handoffKeep `##` sections
  const sections = updated.split(/(?=^## )/m).filter(s => s.trim());
  const pruned = sections.slice(-handoffKeep).join('\n');
  fs.writeFileSync(HANDOFF_FILE, pruned.trimStart() + '\n', 'utf8');
}

/**
 * Read the most recent entry from HANDOFF.md for system prompt injection.
 * Returns empty string if the file doesn't exist or is empty.
 */
export function readHandoff() {
  if (!fs.existsSync(HANDOFF_FILE)) return '';
  const raw = fs.readFileSync(HANDOFF_FILE, 'utf8');
  const sections = raw.split(/(?=^## )/m).filter(s => s.trim());
  return sections.length > 0 ? sections[sections.length - 1].trim() : '';
}

// --- Display ---

/**
 * Parse MEMORY.md index into structured entries for UI and display use.
 */
export function readIndexEntries() {
  const memoryIndex = getMemoryIndex();
  if (!fs.existsSync(memoryIndex)) return [];
  const raw = fs.readFileSync(memoryIndex, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const parsed = parseIndexLine(line);
    if (!parsed) continue;
    const dateMatch    = parsed.rest.match(/(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})?)/);
    const summaryMatch = parsed.rest.match(/--\s+(.+)$/);
    entries.push({
      name:     parsed.name,
      filename: parsed.filename,
      date:     dateMatch    ? dateMatch[1]    : '—',
      summary:  summaryMatch ? summaryMatch[1] : '',
      pinned:   parsed.rest.includes('[pin]'),
      stale:    parsed.rest.includes('[stale?]'),
    });
  }
  return entries;
}

/**
 * Read a topic file's body (frontmatter stripped) for display.
 */
export function readTopicContent(filename) {
  const filePath = path.join(getMemoryDir(), filename);
  if (!fs.existsSync(filePath)) return '_(file not found)_';
  const raw = fs.readFileSync(filePath, 'utf8');
  const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/);
  return fmMatch ? raw.slice(fmMatch[0].length).trimStart() : raw;
}
