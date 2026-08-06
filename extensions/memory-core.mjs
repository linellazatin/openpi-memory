/**
 * memory-core.mjs
 *
 * Platform-agnostic memory logic. No pi imports — importable by both the
 * extension (via jiti) and the smoke test (plain node).
 *
 * Storage path respects PI_CODING_AGENT_DIR (pi's config-dir override).
 * Set it before importing this module; the constants are fixed at load time.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Storage paths ---

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
export const MEMORY_DIR = path.join(AGENT_DIR, 'memory');
export const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');
export const MEMORY_RULES = path.join(MEMORY_DIR, 'RULES.jsonc');

// --- Constants ---

export const MAX_LINES = 200;
export const MAX_BYTES = 25 * 1024;
export const DEFAULT_STALE_DAYS = 180;
export const DEFAULT_INJECT_INTERVAL = 5;

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
    "Session-specific context that won't apply to future sessions",
    "Assumed or inferred preferences — only persist what the user has explicitly stated",
    "Large blocks of code — summarize instead, or link to the file path"
  ],
  // Always ask before persisting these (non-overridable)
  "always_ask": [
    "Credentials, tokens, API keys",
    "Personal data",
    "Anything the user marks as private or ephemeral"
  ],
  // max_lines: valid range 50–500
  "max_lines": 200,
  // stale_after_days: 0 = disable age flagging
  "stale_after_days": 180,
  // inject_every_n_turns: re-inject memory every N user prompts; 1 = every prompt
  "inject_every_n_turns": 5
}
`;

// --- Config (RULES.jsonc) ---

/**
 * Read and parse RULES.jsonc. Creates the file with defaults if missing.
 * Strips // line comments and trailing commas before JSON.parse.
 * Clamps all scalar values to valid ranges.
 */
export function parseRules() {
  try {
    if (!fs.existsSync(MEMORY_RULES)) {
      ensureMemoryDir();
      fs.writeFileSync(MEMORY_RULES, INITIAL_RULES_JSONC, 'utf8');
    }
    const raw = fs.readFileSync(MEMORY_RULES, 'utf8');
    const stripped = raw
      .replace(/\/\/[^\n]*/g, '')
      .replace(/,\s*([}\]])/g, '$1');
    const obj = JSON.parse(stripped);

    return {
      alwaysPersist: Array.isArray(obj.always_persist) ? obj.always_persist : [],
      neverPersist:  Array.isArray(obj.never_persist)  ? obj.never_persist  : [],
      alwaysAsk:     Array.isArray(obj.always_ask)     ? obj.always_ask     : [],
      maxLines:          Math.min(500, Math.max(50,  typeof obj.max_lines          === 'number' ? obj.max_lines          : MAX_LINES)),
      staleAfterDays:    Math.max(0,               typeof obj.stale_after_days    === 'number' ? obj.stale_after_days    : DEFAULT_STALE_DAYS),
      injectEveryNTurns: Math.max(1,               typeof obj.inject_every_n_turns === 'number' ? obj.inject_every_n_turns : DEFAULT_INJECT_INTERVAL),
    };
  } catch {
    return {
      alwaysPersist: [],
      neverPersist:  [],
      alwaysAsk:     [],
      maxLines:          MAX_LINES,
      staleAfterDays:    DEFAULT_STALE_DAYS,
      injectEveryNTurns: DEFAULT_INJECT_INTERVAL,
    };
  }
}

/**
 * Render parsed rules to markdown for system prompt injection.
 * Config scalars (max_lines, stale_after_days, inject_every_n_turns) are
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

// --- File I/O helpers ---

export function ensureMemoryDir() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

/**
 * Read MEMORY.md, truncating if over maxLines or MAX_BYTES.
 * Creates the file with INITIAL_MEMORY if missing.
 */
export function readMemoryIndex(maxLines) {
  try {
    if (!fs.existsSync(MEMORY_INDEX)) {
      ensureMemoryDir();
      fs.writeFileSync(MEMORY_INDEX, INITIAL_MEMORY, 'utf8');
      return INITIAL_MEMORY;
    }
    const raw = fs.readFileSync(MEMORY_INDEX, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > maxLines || Buffer.byteLength(raw) > MAX_BYTES) {
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

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// Returns current local datetime as ISO 8601 with host timezone offset: 2026-08-06T23:15:30+08:00
export function nowIso() {
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
export function updateFrontmatterLastUpdated(fileContent, datetime) {
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
export function maintainIndex(lines, config) {
  const { staleAfterDays } = config;
  // linear scan, O(n) per call; n is bounded by max_lines (≤500)
  const seen = new Map(); // filename → result array index
  const result = [];

  for (const line of lines) {
    const parsed = parseIndexLine(line);
    if (!parsed) {
      result.push(line);
      continue;
    }

    const { filename } = parsed;
    let rest = parsed.rest;

    // Orphan: topic file no longer exists
    if (!fs.existsSync(path.join(MEMORY_DIR, filename))) continue;

    // Duplicate: keep entry with newer date
    if (seen.has(filename)) {
      const existingIdx = seen.get(filename);
      const existingLine = result[existingIdx];
      const existingDate = (existingLine?.match(/(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? '';
      const thisDate     = (rest.match(/(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? '';
      if (thisDate > existingDate) {
        result[existingIdx] = null; // evict older
        seen.set(filename, result.length);
      } else {
        continue; // skip this one (existing is newer)
      }
    } else {
      seen.set(filename, result.length);
    }

    // Stale stamping / healing
    const isPinned = rest.includes('[pin]');
    if (!isPinned && staleAfterDays > 0) {
      // Match full ISO datetime (2026-08-07T01:02:50+08:00) or legacy date-only (2026-08-06)
      const dateMatch = rest.match(/(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})?)/);
      if (dateMatch) {
        const age = daysSince(dateMatch[1]);
        if (age !== null && age > staleAfterDays) {
          if (!rest.includes('[stale?]'))
            rest = rest.replace(dateMatch[1], `${dateMatch[1]} [stale?]`);
        } else {
          rest = rest.replace(' [stale?]', '');
        }
      }
    }

    result.push(parsed.prefix + parsed.name + parsed.mid + rest);
  }

  return result.filter(l => l !== null);
}

/**
 * Find the first index entry whose name or filename matches the search string
 * (case-insensitive, substring match).
 */
export function findIndexEntry(lines, search) {
  const s = search.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseIndexLine(lines[i]);
    if (!parsed) continue;
    if (parsed.name.toLowerCase().includes(s) || parsed.filename.toLowerCase().includes(s))
      return { idx: i, parsed };
  }
  return null;
}

// --- Concurrency ---

// process-global mutex; safe for single-user extension.
// Upgrade to per-topic lock if high-frequency concurrent writes become an issue.
let writeLock = false;
export async function withLock(fn) {
  while (writeLock) await new Promise(r => setTimeout(r, 10));
  writeLock = true;
  try {
    return await fn();
  } finally {
    writeLock = false;
  }
}

// --- Tool execute functions ---
// Called by both pi tools (index.ts) and /memory command handler directly.

export async function executeWriteMemory({ topic, content, summary, pin = false, overwrite = false }) {
  return withLock(() => {
    ensureMemoryDir();

    // Read index once — reused for topic-name lookup and upsert
    const rawIndex = fs.existsSync(MEMORY_INDEX)
      ? fs.readFileSync(MEMORY_INDEX, 'utf8')
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
    const topicPath = path.join(MEMORY_DIR, filename);

    let isNew = false;
    const dt = nowIso();
    if (!fs.existsSync(topicPath)) {
      isNew = true;
      const frontmatter =
        `---\nname: ${topic}\ndescription: ${summary}\ncreated: ${dt}\nlast_updated: ${dt}\nmetadata:\n  node_type: memory\n---\n\n`;
      fs.writeFileSync(topicPath, frontmatter + content + '\n', 'utf8');
    } else if (overwrite) {
      // Replace body content; preserve frontmatter and update last_updated
      const existing = fs.readFileSync(topicPath, 'utf8');
      const updated = updateFrontmatterLastUpdated(existing, dt);
      // Strip everything after the closing frontmatter --- and replace with new content
      const bodyStart = updated.indexOf('---\n', 4) + 4; // skip past the closing ---
      fs.writeFileSync(topicPath, updated.slice(0, bodyStart) + '\n' + content + '\n', 'utf8');
    } else {
      const existing = fs.readFileSync(topicPath, 'utf8');
      const updated = updateFrontmatterLastUpdated(existing, dt);
      fs.writeFileSync(topicPath, updated + `\n## ${today()}\n\n` + content + '\n', 'utf8');
    }

    let lines = rawIndex.split('\n');
    lines = upsertIndexLine(lines, filename, topic, summary, pin);
    lines = maintainIndex(lines, parseRules());
    fs.writeFileSync(MEMORY_INDEX, lines.join('\n'), 'utf8');

    return `${isNew ? 'Created' : 'Updated'} memory topic "${topic}" (${filename}).`;
  });
}

export async function executeRemoveMemory({ topic }) {
  return withLock(() => {
    if (!fs.existsSync(MEMORY_INDEX)) return 'No memory index found.';

    const lines = fs.readFileSync(MEMORY_INDEX, 'utf8').split('\n');
    const found = findIndexEntry(lines, topic);

    if (!found) return `No entry found matching "${topic}".`;

    if (found.parsed.rest.includes('[pin]'))
      return `Cannot remove "${found.parsed.name}" — it is pinned. Unpin it first with: /memory unpin ${topic}`;

    lines.splice(found.idx, 1);
    fs.writeFileSync(MEMORY_INDEX, lines.join('\n'), 'utf8');
    return `Removed "${found.parsed.name}" from the index. Topic file is preserved on disk.`;
  });
}

export async function executePinMemory({ topic, pin }) {
  return withLock(() => {
    if (!fs.existsSync(MEMORY_INDEX)) return 'No memory index found.';

    const lines = fs.readFileSync(MEMORY_INDEX, 'utf8').split('\n');
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

    fs.writeFileSync(MEMORY_INDEX, lines.join('\n'), 'utf8');
    return `${pin ? 'Pinned' : 'Unpinned'} "${parsed.name}".\nBefore: ${before}\n After: ${lines[idx]}`;
  });
}

// --- Display ---

/**
 * Parse MEMORY.md index into structured entries for UI and display use.
 */
export function readIndexEntries() {
  if (!fs.existsSync(MEMORY_INDEX)) return [];
  const raw = fs.readFileSync(MEMORY_INDEX, 'utf8');
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
  const filePath = path.join(MEMORY_DIR, filename);
  if (!fs.existsSync(filePath)) return '_(file not found)_';
  const raw = fs.readFileSync(filePath, 'utf8');
  const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/);
  return fmMatch ? raw.slice(fmMatch[0].length).trimStart() : raw;
}

/**
 * Format MEMORY.md index as a markdown table (fallback / plain-text contexts).
 */
export function formatMemoryTable() {
  const entries = readIndexEntries();
  if (entries.length === 0)
    return 'Memory index is empty. Use `/memory <text>` to store something.';

  const rows = entries
    .map(e => `| ${e.name} | ${e.date} | ${e.pinned ? 'Yes' : 'No'} | ${e.stale ? 'Yes' : 'No'} |`)
    .join('\n');

  return [
    '| Topic | Date | Pinned | Stale |',
    '|---|---|---|---|',
    rows,
  ].join('\n');
}
