/**
 * Smoke tests for openpi-memory
 *
 * Run: node test.mjs
 *
 * STATE ISOLATION:
 * PI_CODING_AGENT_DIR is fixed at memory-core load time; getMemoryDir()/getMemoryIndex()
 * resolve fresh on every call based on parseRules().sharedDir (default false, so they
 * resolve under PI_CODING_AGENT_DIR/memory/ unless a test explicitly sets shared_dir: true).
 * We set PI_CODING_AGENT_DIR to a temp dir before the dynamic import so
 * the module initialises against the temp dir for the entire run.
 *
 * Tests are sequential; each section notes any state dependencies.
 */

import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Temp dir setup (must happen before importing memory-core) ──────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpi-memory-test-'));
process.env.PI_CODING_AGENT_DIR = TMP;

const SHARED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'openpi-memory-shared-home-'));
process.env.PI_SHARED_MEMORY_HOME = SHARED_HOME;

process.on('exit', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(SHARED_HOME, { recursive: true, force: true });
});

// ── Import core (after PI_CODING_AGENT_DIR is set) ────────────────────────

const {
  getMemoryDir,
  getMemoryIndex,
  MEMORY_RULES,
  HANDOFF_FILE,
  DEFAULT_AUTO_RESUME_AFTER_THRESHOLD,
  DEFAULT_CONSOLIDATE_ON_COMPACT,
  buildCompactionConsolidationPrompt,
  parseRules,
  renderRulesToMarkdown,
  toSlug,
  parseIndexLine,
  upsertIndexLine,
  maintainIndex,
  executeWriteMemory,
  executeRemoveMemory,
  executePinMemory,
  readIndexEntries,
  readTopicContent,
  writeHandoff,
  readHandoff,
  searchMemory,
  detectIncompleteTask,
  _resetCarryOver,
} = await import('../extensions/memory-core.mjs');

// ── Test runner ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// Helper: write memory.jsonc with custom content
function writeRules(content) {
  fs.mkdirSync(path.dirname(MEMORY_RULES), { recursive: true });
  fs.writeFileSync(MEMORY_RULES, content, 'utf8');
}

// Helper: read MEMORY.md
function readIndex() {
  return fs.existsSync(getMemoryIndex()) ? fs.readFileSync(getMemoryIndex(), 'utf8') : null;
}

// ═══════════════════════════════════════════════════════════
// 1. parseRules — clamping and JSONC parsing
// ═══════════════════════════════════════════════════════════

console.log('\n--- 1. parseRules ---');

await test('defaults: missing file returns defaults', async () => {
  // Remove any existing RULES.jsonc so defaults are exercised
  if (fs.existsSync(MEMORY_RULES)) fs.unlinkSync(MEMORY_RULES);
  const r = parseRules();
  assert.equal(r.maxLines, 300, 'default maxLines');
  assert.equal(r.staleAfterDays, 180, 'default staleAfterDays');
  assert.equal(r.injectEveryNTurns, 5, 'default injectEveryNTurns');
});

await test('max_lines clamps to 50 minimum', async () => {
  writeRules('{ "max_lines": 10 }');
  const r = parseRules();
  assert.equal(r.maxLines, 50, 'should clamp to 50');
});

await test('max_lines clamps to 1000 maximum', async () => {
  writeRules('{ "max_lines": 9999 }');
  const r = parseRules();
  assert.equal(r.maxLines, 1000, 'should clamp to 1000');
});

await test('stale_after_days=0 disables stale flagging', async () => {
  writeRules('{ "stale_after_days": 0 }');
  const r = parseRules();
  assert.equal(r.staleAfterDays, 0, 'should allow 0');
});

await test('inject_every_n_turns clamps to 1 minimum', async () => {
  writeRules('{ "inject_every_n_turns": 0 }');
  const r = parseRules();
  assert.equal(r.injectEveryNTurns, 1, 'should clamp to 1');
});

await test('handoff_keep defaults to 3', async () => {
  if (fs.existsSync(MEMORY_RULES)) fs.unlinkSync(MEMORY_RULES);
  const r = parseRules();
  assert.equal(r.handoffKeep, 3, 'default handoffKeep');
});

await test('handoff_keep=0 disables handoff', async () => {
  writeRules('{ "handoff_keep": 0 }');
  const r = parseRules();
  assert.equal(r.handoffKeep, 0, 'should allow 0');
});

await test('JSONC: // line comments are stripped', async () => {
  writeRules(`{
    // this is a comment
    "max_lines": 100,
    "inject_every_n_turns": 3
  }`);
  const r = parseRules();
  assert.equal(r.maxLines, 100, 'max_lines parsed through comment strip');
  assert.equal(r.injectEveryNTurns, 3, 'inject_every_n_turns parsed');
});

await test('JSONC: trailing commas are tolerated', async () => {
  writeRules(`{
    "max_lines": 75,
    "stale_after_days": 90,
  }`);
  const r = parseRules();
  assert.equal(r.maxLines, 75, 'max_lines parsed with trailing comma');
  assert.equal(r.staleAfterDays, 90, 'stale_after_days parsed');
});

await test('rules arrays are parsed', async () => {
  writeRules(`{
    "always_persist": ["Fact A", "Fact B"],
    "never_persist": ["Skip this"],
    "always_ask": ["Credentials"]
  }`);
  const r = parseRules();
  assert.deepEqual(r.alwaysPersist, ['Fact A', 'Fact B']);
  assert.deepEqual(r.neverPersist, ['Skip this']);
  assert.deepEqual(r.alwaysAsk, ['Credentials']);
});

// ═══════════════════════════════════════════════════════════
// 2. renderRulesToMarkdown — output shape
// ═══════════════════════════════════════════════════════════

console.log('\n--- 2. renderRulesToMarkdown ---');

await test('sections are present in output', async () => {
  const rules = {
    alwaysPersist: ['Item A'],
    neverPersist: ['Item B'],
    alwaysAsk: ['Credentials'],
    maxLines: 200,
    staleAfterDays: 180,
    injectEveryNTurns: 5,
  };
  const md = renderRulesToMarkdown(rules);
  assert.ok(md.includes('## Always persist'), 'always persist section');
  assert.ok(md.includes('## Never persist'), 'never persist section');
  assert.ok(md.includes('## Always ask before persisting'), 'always ask section');
  assert.ok(md.includes('- Item A'), 'item rendered');
});

await test('config scalars are not in rendered output', async () => {
  const rules = {
    alwaysPersist: ['X'],
    neverPersist: [],
    alwaysAsk: [],
    maxLines: 123,
    staleAfterDays: 45,
    injectEveryNTurns: 7,
  };
  const md = renderRulesToMarkdown(rules);
  assert.ok(!md.includes('max_lines'), 'max_lines not in output');
  assert.ok(!md.includes('stale_after_days'), 'stale_after_days not in output');
  assert.ok(!md.includes('inject_every_n_turns'), 'inject_every_n_turns not in output');
  assert.ok(!md.includes('123'), 'scalar value not in output');
});

await test('empty arrays produce no section', async () => {
  const rules = { alwaysPersist: ['X'], neverPersist: [], alwaysAsk: [], maxLines: 200, staleAfterDays: 180, injectEveryNTurns: 5 };
  const md = renderRulesToMarkdown(rules);
  assert.ok(!md.includes('## Never persist'), 'empty section omitted');
  assert.ok(!md.includes('## Always ask'), 'empty section omitted');
});

// ═══════════════════════════════════════════════════════════
// 3. toSlug / parseIndexLine
// ═══════════════════════════════════════════════════════════

console.log('\n--- 3. toSlug / parseIndexLine ---');

await test('toSlug: spaces become hyphens, lowercase', async () => {
  assert.equal(toSlug('PostgreSQL Setup'), 'postgresql-setup');
});

await test('toSlug: special chars removed, consecutive hyphens collapsed', async () => {
  assert.equal(toSlug('Node.js & npm!'), 'nodejs-npm');
});

await test('parseIndexLine: parses standard entry', async () => {
  const parsed = parseIndexLine('- [PostgreSQL Setup](postgresql-setup.md) 2026-01-01 -- Database config');
  assert.ok(parsed, 'should parse');
  assert.equal(parsed.name, 'PostgreSQL Setup');
  assert.equal(parsed.filename, 'postgresql-setup.md');
});

await test('parseIndexLine: detects [pin] in rest', async () => {
  const parsed = parseIndexLine('- [Topic](topic.md) [pin] 2026-01-01 -- summary');
  assert.ok(parsed, 'should parse');
  assert.ok(parsed.rest.includes('[pin]'), 'pin detected in rest');
});

await test('parseIndexLine: returns null for non-entry lines', async () => {
  assert.equal(parseIndexLine('# Memory Index'), null);
  assert.equal(parseIndexLine(''), null);
  assert.equal(parseIndexLine('Some random text'), null);
});

// ═══════════════════════════════════════════════════════════
// 4. upsertIndexLine / maintainIndex
// ═══════════════════════════════════════════════════════════

console.log('\n--- 4. upsertIndexLine / maintainIndex ---');

await test('upsertIndexLine: adds new entry with full datetime', async () => {
  const lines = ['# Memory Index', ''];
  const result = upsertIndexLine(lines, 'test.md', 'Test', 'A test entry', false);
  const entry = result.find(l => l.includes('test.md'));
  assert.ok(entry, 'entry should be added');
  assert.ok(entry.includes('Test'), 'name in entry');
  assert.ok(entry.includes('A test entry'), 'summary in entry');
  assert.ok(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/.test(entry), 'entry has full datetime with tz offset');
});

await test('upsertIndexLine: updates existing entry by filename', async () => {
  const lines = [
    '# Memory Index',
    '- [Old Topic](test.md) 2025-01-01 -- old summary',
  ];
  const result = upsertIndexLine(lines, 'test.md', 'New Topic', 'new summary', false);
  const entries = result.filter(l => l.includes('test.md'));
  assert.equal(entries.length, 1, 'no duplicate');
  assert.ok(entries[0].includes('new summary'), 'summary updated');
});

await test('upsertIndexLine: preserves existing pin on update', async () => {
  const lines = ['- [Topic](t.md) [pin] 2025-01-01 -- summary'];
  const result = upsertIndexLine(lines, 't.md', 'Topic', 'new summary', false);
  assert.ok(result[0].includes('[pin]'), 'pin preserved on update');
});

await test('maintainIndex: removes orphaned entries', async () => {
  // Create a fake topic file, add to index, then delete the file
  fs.mkdirSync(getMemoryDir(), { recursive: true });
  const orphanPath = path.join(getMemoryDir(), 'orphan.md');
  fs.writeFileSync(orphanPath, '---\nname: Orphan\n---\n', 'utf8');

  let lines = ['# Memory Index', '- [Orphan](orphan.md) 2026-01-01 -- orphan entry'];
  fs.unlinkSync(orphanPath); // delete the file

  const config = { staleAfterDays: 180 };
  const result = maintainIndex(lines, config);
  assert.ok(!result.some(l => l.includes('orphan.md')), 'orphan removed');
});

await test('maintainIndex: deduplicates by filename (keeps newer date)', async () => {
  fs.mkdirSync(getMemoryDir(), { recursive: true });
  const dupPath = path.join(getMemoryDir(), 'dup.md');
  fs.writeFileSync(dupPath, '---\nname: Dup\n---\n', 'utf8');

  const lines = [
    '# Memory Index',
    '- [Dup v1](dup.md) 2025-01-01 -- older',
    '- [Dup v2](dup.md) 2026-01-01 -- newer',
  ];
  const result = maintainIndex(lines, { staleAfterDays: 180 });
  const entries = result.filter(l => l.includes('dup.md'));
  assert.equal(entries.length, 1, 'one entry after dedup');
  assert.ok(entries[0].includes('2026-01-01'), 'newer date kept');

  fs.unlinkSync(dupPath);
});

await test('maintainIndex: stamps [stale?] on old entries', async () => {
  fs.mkdirSync(getMemoryDir(), { recursive: true });
  const stalePath = path.join(getMemoryDir(), 'stale-topic.md');
  fs.writeFileSync(stalePath, '---\nname: Stale\n---\n', 'utf8');

  const lines = ['- [Stale](stale-topic.md) 2020-01-01 -- very old'];
  const result = maintainIndex(lines, { staleAfterDays: 180 });
  assert.ok(result.some(l => l.includes('[stale?]')), 'stale flag added');

  fs.unlinkSync(stalePath);
});

await test('maintainIndex: stale_after_days=0 disables stale flagging', async () => {
  fs.mkdirSync(getMemoryDir(), { recursive: true });
  const nostale = path.join(getMemoryDir(), 'nostale.md');
  fs.writeFileSync(nostale, '---\nname: NoStale\n---\n', 'utf8');

  const lines = ['- [NoStale](nostale.md) 2020-01-01 -- old but no stale flag'];
  const result = maintainIndex(lines, { staleAfterDays: 0 });
  assert.ok(!result.some(l => l.includes('[stale?]')), 'no stale flag when disabled');

  fs.unlinkSync(nostale);
});

// ═══════════════════════════════════════════════════════════
// 5. write_memory tool execute
// ═══════════════════════════════════════════════════════════

console.log('\n--- 5. write_memory ---');

// Reset index for clean tool tests
fs.mkdirSync(getMemoryDir(), { recursive: true });
fs.writeFileSync(getMemoryIndex(), '# Memory Index\n\n', 'utf8');
writeRules('{ "max_lines": 200, "stale_after_days": 180, "inject_every_n_turns": 5 }');

await test('write_memory: creates topic file and index entry', async () => {
  const result = await executeWriteMemory({
    topic: 'PostgreSQL Setup',
    content: 'Connection string: postgres://localhost:5432/mydb',
    summary: 'Postgres connection config',
    pin: false,
  });
  assert.ok(result.includes('Created'), 'result says Created');
  assert.ok(result.includes('postgresql-setup.md'), 'filename in result');

  const idx = readIndex();
  assert.ok(idx.includes('PostgreSQL Setup'), 'entry in index');
  assert.ok(idx.includes('postgresql-setup.md'), 'filename in index');
  assert.ok(idx.includes('Postgres connection config'), 'summary in index');

  // frontmatter: both created and last_updated with time
  const topicContent = fs.readFileSync(path.join(getMemoryDir(), 'postgresql-setup.md'), 'utf8');
  assert.ok(topicContent.includes('created:'), 'created field present');
  assert.ok(topicContent.includes('last_updated:'), 'last_updated field present');
  assert.ok(/created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/.test(topicContent), 'created has datetime with tz offset');
  assert.ok(/last_updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/.test(topicContent), 'last_updated has datetime with tz offset');
});

await test('write_memory: second write appends with date heading and updates last_updated', async () => {
  await executeWriteMemory({
    topic: 'PostgreSQL Setup',
    content: 'Added replica connection string.',
    summary: 'Postgres connection config',
    pin: false,
  });
  const result = await executeWriteMemory({
    topic: 'PostgreSQL Setup',
    content: 'Added replica connection string.',
    summary: 'Postgres connection config',
    pin: false,
  });
  assert.ok(result.includes('Updated'), 'result says Updated');

  const topicPath = path.join(getMemoryDir(), 'postgresql-setup.md');
  const content = fs.readFileSync(topicPath, 'utf8');
  assert.ok(content.includes('## '), 'date heading appended');
  assert.ok(/last_updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/.test(content), 'last_updated refreshed');
  // only one created: field (not duplicated)
  assert.equal((content.match(/^created:/mg) || []).length, 1, 'created appears exactly once');
});

await test('write_memory: mode=replace replaces body, preserves frontmatter, updates last_updated', async () => {
  await executeWriteMemory({
    topic: 'PostgreSQL Setup',
    content: 'Replaced: connection string updated to postgres://newhost:5432/mydb',
    summary: 'Postgres connection config',
    pin: false,
    mode: 'replace',
  });
  const topicPath = path.join(getMemoryDir(), 'postgresql-setup.md');
  const content = fs.readFileSync(topicPath, 'utf8');
  assert.ok(content.includes('Replaced:'), 'new content present');
  assert.ok(!content.includes('Connection string: postgres://localhost'), 'old content gone');
  assert.ok(content.startsWith('---'), 'frontmatter intact');
  assert.ok(/last_updated: \d{4}-\d{2}-\d{2}T/.test(content), 'last_updated refreshed');
  assert.equal((content.match(/^## \d{4}-\d{2}-\d{2}/mg) || []).length, 0, 'no date heading on replace');
});

await test('write_memory: mode=replace does not duplicate content across multiple calls', async () => {
  await executeWriteMemory({
    topic: 'PostgreSQL Setup',
    content: 'Final state: postgres://finalhost:5432/mydb',
    summary: 'Postgres connection config',
    pin: false,
    mode: 'replace',
  });
  const content = fs.readFileSync(path.join(getMemoryDir(), 'postgresql-setup.md'), 'utf8');
  assert.ok(!content.includes('Replaced:'), 'previous replace body gone');
  assert.ok(content.includes('Final state:'), 'latest content present');
  assert.equal((content.match(/Final state:/g) || []).length, 1, 'no duplicate body');
});

await test('write_memory: overwrite=true (legacy) behaves same as mode=replace', async () => {
  await executeWriteMemory({
    topic: 'PostgreSQL Setup',
    content: 'Legacy overwrite: postgres://legacyhost:5432/mydb',
    summary: 'Postgres connection config',
    overwrite: true,
  });
  const content = fs.readFileSync(path.join(getMemoryDir(), 'postgresql-setup.md'), 'utf8');
  assert.ok(content.includes('Legacy overwrite:'), 'overwrite compat: new content present');
  assert.ok(!content.includes('Final state:'), 'overwrite compat: old content gone');
  assert.equal((content.match(/^## \d{4}-\d{2}-\d{2}/mg) || []).length, 0, 'no date heading');
});

await test('write_memory: pin=true adds [pin] to index', async () => {
  await executeWriteMemory({
    topic: 'Homelab Server',
    content: 'IP: 192.168.1.100',
    summary: 'Homelab server IP',
    pin: true,
  });
  const idx = readIndex();
  const line = idx.split('\n').find(l => l.includes('homelab-server.md'));
  assert.ok(line, 'entry in index');
  assert.ok(line.includes('[pin]'), '[pin] present');
});

// ═══════════════════════════════════════════════════════════
// 6. pin_memory tool execute
// ═══════════════════════════════════════════════════════════

console.log('\n--- 6. pin_memory ---');

await test('pin_memory: pin an unpinned entry', async () => {
  await executeWriteMemory({
    topic: 'Redis Commands',
    content: 'FLUSHDB, KEYS *, TTL',
    summary: 'Useful Redis commands',
    pin: false,
  });
  const result = await executePinMemory({ topic: 'Redis Commands', pin: true });
  assert.ok(result.toLowerCase().includes('pinned'), 'result confirms pin');
  const idx = readIndex();
  const line = idx.split('\n').find(l => l.includes('redis-commands.md'));
  assert.ok(line.includes('[pin]'), '[pin] added');
});

await test('pin_memory: unpin a pinned entry', async () => {
  const result = await executePinMemory({ topic: 'Redis Commands', pin: false });
  assert.ok(result.toLowerCase().includes('unpinned'), 'result confirms unpin');
  const idx = readIndex();
  const line = idx.split('\n').find(l => l.includes('redis-commands.md'));
  assert.ok(!line.includes('[pin]'), '[pin] removed');
});

await test('pin_memory: already-pinned returns early', async () => {
  await executePinMemory({ topic: 'Homelab Server', pin: true }); // already pinned
  const result = await executePinMemory({ topic: 'Homelab Server', pin: true });
  assert.ok(result.includes('already pinned'), 'already pinned message');
});

// ═══════════════════════════════════════════════════════════
// 7. remove_memory tool execute
// ═══════════════════════════════════════════════════════════

console.log('\n--- 7. remove_memory ---');

await test('remove_memory: removes index entry, file stays on disk', async () => {
  await executeWriteMemory({
    topic: 'Temp Notes',
    content: 'Some temporary notes.',
    summary: 'Temp notes',
    pin: false,
  });
  const filePath = path.join(getMemoryDir(), 'temp-notes.md');
  assert.ok(fs.existsSync(filePath), 'file exists before remove');

  const result = await executeRemoveMemory({ topic: 'Temp Notes' });
  assert.ok(result.toLowerCase().includes('removed'), 'result confirms removal');

  const idx = readIndex();
  assert.ok(!idx.includes('temp-notes.md'), 'entry removed from index');
  assert.ok(fs.existsSync(filePath), 'file still on disk');
});

await test('remove_memory: pinned entry cannot be removed', async () => {
  const result = await executeRemoveMemory({ topic: 'Homelab Server' });
  assert.ok(result.toLowerCase().includes('pinned'), 'refuses pinned entry');
  const idx = readIndex();
  assert.ok(idx.includes('homelab-server.md'), 'entry still in index');
});

await test('remove_memory: unknown topic returns not-found message', async () => {
  const result = await executeRemoveMemory({ topic: 'Does Not Exist' });
  assert.ok(result.toLowerCase().includes('no entry'), 'not-found message');
});

// ═══════════════════════════════════════════════════════════
// 8. readIndexEntries / readTopicContent
// ═══════════════════════════════════════════════════════════

console.log('\n--- 8. readIndexEntries / readTopicContent ---');

await test('readIndexEntries: returns structured entries', async () => {
  const entries = readIndexEntries();
  assert.ok(Array.isArray(entries), 'returns array');
  const e = entries.find(e => e.filename === 'homelab-server.md');
  assert.ok(e, 'homelab-server entry present');
  assert.ok(e.pinned, 'entry is pinned');
  assert.ok(e.date, 'entry has date');
});

await test('readTopicContent: returns body without frontmatter', async () => {
  const body = readTopicContent('homelab-server.md');
  assert.ok(!body.startsWith('---'), 'frontmatter stripped');
  assert.ok(body.includes('192.168.1.100'), 'content present');
});

await test('readTopicContent: missing file returns not-found message', async () => {
  const body = readTopicContent('nonexistent.md');
  assert.ok(body.includes('not found'), 'not-found message');
});

// ═══════════════════════════════════════════════════════════
// 9. writeHandoff / readHandoff
// ═══════════════════════════════════════════════════════════

console.log('\n--- 9. writeHandoff / readHandoff ---');

const fakeMessages = (texts) => texts.map(text => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
}));

await test('readHandoff: returns empty string when no file', async () => {
  if (fs.existsSync(HANDOFF_FILE)) fs.unlinkSync(HANDOFF_FILE);
  assert.equal(readHandoff(), '', 'empty when missing');
});

await test('writeHandoff: creates HANDOFF.md with bullet entry', async () => {
  writeHandoff(fakeMessages(['Working on feature A', 'Editing file foo.ts']), 'manual', 3);
  assert.ok(fs.existsSync(HANDOFF_FILE), 'HANDOFF.md created');
  const content = fs.readFileSync(HANDOFF_FILE, 'utf8');
  assert.ok(content.includes('(manual)'), 'reason in entry header');
  assert.ok(content.includes('- '), 'has bullet points');
});

await test('readHandoff: returns most recent entry only', async () => {
  writeHandoff(fakeMessages(['Second compaction work']), 'threshold', 3);
  const entry = readHandoff();
  assert.ok(entry.includes('threshold'), 'most recent entry is threshold');
  assert.ok(!entry.includes('manual'), 'older manual entry not included');
});

await test('writeHandoff: prunes to handoff_keep sections', async () => {
  writeHandoff(fakeMessages(['Third']), 'manual', 2);
  writeHandoff(fakeMessages(['Fourth']), 'overflow', 2);
  const content = fs.readFileSync(HANDOFF_FILE, 'utf8');
  const sections = content.split(/(?=^## )/m).filter(s => s.trim());
  assert.equal(sections.length, 2, 'pruned to 2 sections');
});

await test('writeHandoff: handoff_keep=0 is a no-op', async () => {
  if (fs.existsSync(HANDOFF_FILE)) fs.unlinkSync(HANDOFF_FILE);
  writeHandoff(fakeMessages(['Should not write']), 'manual', 0);
  assert.ok(!fs.existsSync(HANDOFF_FILE), 'file not created when keep=0');
});

await test('writeHandoff: skips non-assistant messages and empty blocks', async () => {
  if (fs.existsSync(HANDOFF_FILE)) fs.unlinkSync(HANDOFF_FILE);
  const mixed = [
    { role: 'user', content: [{ type: 'text', text: 'user message' }] },
    { role: 'assistant', content: [{ type: 'tool_call', name: 'bash', input: {} }] },
    { role: 'assistant', content: [{ type: 'text', text: 'actual work done' }] },
  ];
  writeHandoff(mixed, 'threshold', 3);
  const content = fs.readFileSync(HANDOFF_FILE, 'utf8');
  assert.ok(!content.includes('user message'), 'user message excluded');
  assert.ok(content.includes('actual work done'), 'assistant text included');
});

// ═══════════════════════════════════════════════════════════
// 10. searchMemory
// ═══════════════════════════════════════════════════════════

console.log('\n--- 10. searchMemory ---');

// Ensure a known topic exists for body search
await executeWriteMemory({
  topic: 'Search Test Topic',
  content: 'unique_searchable_token lives here',
  summary: 'Topic for search testing',
  pin: false,
});

await test('searchMemory: matches by index name', async () => {
  const results = searchMemory('homelab');
  assert.ok(results.length > 0, 'got results');
  assert.ok(results.some(r => r.filename === 'homelab-server.md'), 'found homelab entry');
  assert.ok(results.every(r => r.matchType === 'index' || r.matchType === 'body'), 'matchType set');
});

await test('searchMemory: matches by summary', async () => {
  const results = searchMemory('search testing');
  assert.ok(results.some(r => r.filename === 'search-test-topic.md'), 'found by summary');
  assert.equal(results.find(r => r.filename === 'search-test-topic.md')?.matchType, 'index', 'index match');
});

await test('searchMemory: matches in topic body', async () => {
  // Manually create a file not tracked in index to test body-only path
  const orphan = path.join(getMemoryDir(), 'orphan-body.md');
  fs.writeFileSync(orphan, 'This file has a unique_body_token inside.', 'utf8');
  const results = searchMemory('unique_body_token');
  assert.ok(results.some(r => r.filename === 'orphan-body.md'), 'found in body');
  assert.equal(results.find(r => r.filename === 'orphan-body.md')?.matchType, 'body', 'matchType=body');
  fs.unlinkSync(orphan);
});

await test('searchMemory: no results returns empty array', async () => {
  const results = searchMemory('zzz_no_match_zzz');
  assert.deepEqual(results, [], 'empty array for no matches');
});

await test('searchMemory: index match not duplicated as body match', async () => {
  const results = searchMemory('unique_searchable_token');
  const dupes = results.filter(r => r.filename === 'search-test-topic.md');
  assert.equal(dupes.length, 1, 'no duplicate for same file');
});

await test('searchMemory: case-insensitive', async () => {
  const results = searchMemory('HOMELAB');
  assert.ok(results.some(r => r.filename === 'homelab-server.md'), 'case-insensitive match');
});

// ═══════════════════════════════════════════════════════════
// 11. autoResumeAfterThreshold / detectIncompleteTask
// ═══════════════════════════════════════════════════════════

console.log('\n--- 11. autoResumeAfterThreshold / detectIncompleteTask ---');

await test('parseRules: autoResumeAfterThreshold defaults to false', async () => {
  if (fs.existsSync(MEMORY_RULES)) fs.unlinkSync(MEMORY_RULES);
  const r = parseRules();
  assert.equal(r.autoResumeAfterThreshold, DEFAULT_AUTO_RESUME_AFTER_THRESHOLD, 'default false');
});

await test('parseRules: autoResumeAfterThreshold=true from JSONC', async () => {
  writeRules('{ "auto_resume_after_threshold_compaction": true }');
  const r = parseRules();
  assert.equal(r.autoResumeAfterThreshold, true, 'should parse true');
});

await test('parseRules: autoResumeAfterThreshold=false from JSONC', async () => {
  writeRules('{ "auto_resume_after_threshold_compaction": false }');
  const r = parseRules();
  assert.equal(r.autoResumeAfterThreshold, false, 'should parse false');
});

await test('detectIncompleteTask: finds "need to"', async () => {
  assert.ok(detectIncompleteTask('I need to check the logs next'), 'found need to');
});

await test('detectIncompleteTask: finds "should"', async () => {
  assert.ok(detectIncompleteTask('Should verify the database connection first'), 'found should');
});

await test('detectIncompleteTask: finds "waiting for"', async () => {
  assert.ok(detectIncompleteTask('Waiting for user input before proceeding'), 'found waiting for');
});

await test('detectIncompleteTask: finds "pending"', async () => {
  assert.ok(detectIncompleteTask('Pending migration, not done yet'), 'found pending');
});

await test('detectIncompleteTask: finds "next"', async () => {
  assert.ok(detectIncompleteTask('Next step is to run the tests'), 'found next');
});

await test('detectIncompleteTask: finds "then"', async () => {
  assert.ok(detectIncompleteTask('Then I will deploy to production'), 'found then');
});

await test('detectIncompleteTask: finds "not done"', async () => {
  assert.ok(detectIncompleteTask('This is not done, incomplete work'), 'found not done');
});

await test('detectIncompleteTask: finds "incomplete"', async () => {
  assert.ok(detectIncompleteTask('The task is incomplete and unfinished'), 'found incomplete');
});

await test('detectIncompleteTask: finds "unfinished"', async () => {
  assert.ok(detectIncompleteTask('Unfinished work, need to continue'), 'found unfinished');
});

await test('detectIncompleteTask: no keywords returns false', async () => {
  assert.equal(detectIncompleteTask('I have completed the task. Results are ready.'), false, 'no match');
});

await test('detectIncompleteTask: case-insensitive', async () => {
  assert.ok(detectIncompleteTask('NEED TO check something'), 'case-insensitive');
});

await test('detectIncompleteTask: complex handoff text', async () => {
  const complex = [
    'I have analyzed the logs and found the issue.',
    'Need to verify the database connection next, then run the migration.',
    'Should check the backup status before proceeding.',
  ].join('\n');
  assert.ok(detectIncompleteTask(complex), 'found in complex text');
});

// ═══════════════════════════════════════════════════════════
// 12. consolidate_on_compact
// ═══════════════════════════════════════════════════════════

console.log('\n--- 12. consolidate_on_compact ---');

await test('parseRules: consolidateOnCompact defaults to false', async () => {
  if (fs.existsSync(MEMORY_RULES)) fs.unlinkSync(MEMORY_RULES);
  const r = parseRules();
  assert.equal(r.consolidateOnCompact, DEFAULT_CONSOLIDATE_ON_COMPACT, 'default false');
});

await test('parseRules: consolidateOnCompact=true from JSONC', async () => {
  writeRules('{ "consolidate_on_compact": true }');
  const r = parseRules();
  assert.equal(r.consolidateOnCompact, true, 'should parse true');
});

await test('parseRules: consolidateOnCompact=false from JSONC', async () => {
  writeRules('{ "consolidate_on_compact": false }');
  const r = parseRules();
  assert.equal(r.consolidateOnCompact, false, 'should parse false');
});

// ═══════════════════════════════════════════════════════════
// 13. buildCompactionConsolidationPrompt
// ═══════════════════════════════════════════════════════════

console.log('\n--- 13. buildCompactionConsolidationPrompt ---');

await test('returns a string containing the summary text', async () => {
  const summary = 'We implemented the memory consolidation feature.';
  const prompt = buildCompactionConsolidationPrompt(summary);
  assert.ok(typeof prompt === 'string', 'returns a string');
  assert.ok(prompt.includes(summary), 'contains the summary');
});

await test('contains write_memory instruction', async () => {
  const prompt = buildCompactionConsolidationPrompt('test summary');
  assert.ok(prompt.includes('write_memory'), 'mentions write_memory');
});

await test('contains last-session-recap instruction', async () => {
  const prompt = buildCompactionConsolidationPrompt('test summary');
  assert.ok(prompt.includes('last-session-recap'), 'mentions last-session-recap');
});

console.log('\n--- 14. shared_dir / legacy fallback / carry-over / lock / atomic writes ---');

const LEGACY_DIR_PATH = path.join(TMP, 'memory');
const LEGACY_RULES_PATH = path.join(LEGACY_DIR_PATH, 'RULES.jsonc');
const LEGACY_RULES_BACKUP_PATH = path.join(LEGACY_DIR_PATH, 'RULES.jsonc.bak');
const SHARED_DIR_PATH = path.join(SHARED_HOME, '.agents', 'memory');

await test('shared_dir defaults to false', async () => {
  if (fs.existsSync(MEMORY_RULES)) fs.unlinkSync(MEMORY_RULES);
  const r = parseRules();
  assert.equal(r.sharedDir, false, 'default false');
});

await test('shared_dir=true from JSONC', async () => {
  writeRules('{ "shared_dir": true }');
  const r = parseRules();
  assert.equal(r.sharedDir, true, 'should parse true');
});

await test('shared_dir=false from JSONC', async () => {
  writeRules('{ "shared_dir": false }');
  const r = parseRules();
  assert.equal(r.sharedDir, false, 'should parse false');
});

await test('legacy RULES.jsonc fallback: backs up, copies forward, original untouched', async () => {
  if (fs.existsSync(MEMORY_RULES)) fs.unlinkSync(MEMORY_RULES);
  if (fs.existsSync(LEGACY_RULES_BACKUP_PATH)) fs.unlinkSync(LEGACY_RULES_BACKUP_PATH);
  fs.mkdirSync(LEGACY_DIR_PATH, { recursive: true });
  const legacyContent = '{ "max_lines": 123, "shared_dir": false }';
  fs.writeFileSync(LEGACY_RULES_PATH, legacyContent, 'utf8');

  const r = parseRules();
  assert.equal(r.maxLines, 123, 'reads values from legacy file');
  assert.ok(fs.existsSync(MEMORY_RULES), 'new memory.jsonc created');
  assert.ok(fs.existsSync(LEGACY_RULES_BACKUP_PATH), 'backup created before copy');
  assert.equal(fs.readFileSync(LEGACY_RULES_BACKUP_PATH, 'utf8'), legacyContent, 'backup matches original');
  assert.ok(fs.existsSync(LEGACY_RULES_PATH), 'original legacy file still exists');
  assert.equal(fs.readFileSync(LEGACY_RULES_PATH, 'utf8'), legacyContent, 'original legacy file unchanged');
});

await test('getMemoryDir resolves to legacy dir when shared_dir=false', async () => {
  writeRules('{ "shared_dir": false }');
  assert.equal(getMemoryDir(), LEGACY_DIR_PATH, 'resolves to legacy dir');
});

await test('local carry-over: enabling shared_dir merges into shared, never deletes legacy files', async () => {
  fs.rmSync(SHARED_DIR_PATH, { recursive: true, force: true });
  _resetCarryOver();
  await executeWriteMemory({ topic: 'Carryover Fixture', content: 'carry me over', summary: 'fixture' });
  // Use index entries (not raw dir listing) — mergeLocalIntoSharedDir only copies indexed+present files
  const localIndexRaw = fs.readFileSync(path.join(LEGACY_DIR_PATH, 'MEMORY.md'), 'utf8');
  const localEntries = localIndexRaw.split('\n').map(parseIndexLine).filter(Boolean)
    .filter(e => fs.existsSync(path.join(LEGACY_DIR_PATH, e.filename)));
  const contentsBefore = new Map(localEntries.map(e => [e.filename, fs.readFileSync(path.join(LEGACY_DIR_PATH, e.filename), 'utf8')]));

  writeRules('{ "shared_dir": true }');
  const resolved = getMemoryDir();
  assert.equal(resolved, SHARED_DIR_PATH, 'resolves to shared dir once enabled');
  assert.ok(!fs.existsSync(path.join(SHARED_DIR_PATH, 'HANDOFF.md')), 'HANDOFF.md is not copied to the shared dir');

  const sharedIndexRaw = fs.readFileSync(path.join(SHARED_DIR_PATH, 'MEMORY.md'), 'utf8');
  for (const e of localEntries) {
    assert.ok(fs.existsSync(path.join(SHARED_DIR_PATH, e.filename)), `shared dir contains ${e.filename}`);
    assert.equal(fs.readFileSync(path.join(SHARED_DIR_PATH, e.filename), 'utf8'), contentsBefore.get(e.filename), `${e.filename} copied byte-for-byte`);
    assert.ok(sharedIndexRaw.includes(e.filename), `shared MEMORY.md has entry for ${e.filename}`);
    assert.ok(fs.existsSync(path.join(LEGACY_DIR_PATH, e.filename)), `legacy ${e.filename} still exists`);
    assert.equal(fs.readFileSync(path.join(LEGACY_DIR_PATH, e.filename), 'utf8'), contentsBefore.get(e.filename), `legacy ${e.filename} unchanged`);
  }
});

await test('cross-tool merge: no-collision — foreign shared content and local content coexist', async () => {
  fs.rmSync(SHARED_DIR_PATH, { recursive: true, force: true });
  _resetCarryOver();
  // Pre-seed shared dir as if another tool (e.g. openclaude-memory) already wrote there
  fs.mkdirSync(SHARED_DIR_PATH, { recursive: true });
  fs.writeFileSync(path.join(SHARED_DIR_PATH, 'MEMORY.md'),
    '# Memory Index\n\n- [Foreign Topic](foreign-topic.md) 2026-01-01 -- from another tool\n', 'utf8');
  fs.writeFileSync(path.join(SHARED_DIR_PATH, 'foreign-topic.md'), 'foreign content', 'utf8');

  writeRules('{ "shared_dir": true }');
  getMemoryDir(); // triggers merge

  const sharedIndex = fs.readFileSync(path.join(SHARED_DIR_PATH, 'MEMORY.md'), 'utf8');
  assert.ok(sharedIndex.includes('foreign-topic.md'), 'pre-existing foreign entry preserved');
  // Only check files that are indexed in local MEMORY.md and present on disk
  const localIndexRaw2 = fs.readFileSync(path.join(LEGACY_DIR_PATH, 'MEMORY.md'), 'utf8');
  const localEntries2 = localIndexRaw2.split('\n').map(parseIndexLine).filter(Boolean)
    .filter(e => fs.existsSync(path.join(LEGACY_DIR_PATH, e.filename)));
  for (const e of localEntries2) {
    assert.ok(fs.existsSync(path.join(SHARED_DIR_PATH, e.filename)), `local topic ${e.filename} merged into shared`);
    assert.ok(sharedIndex.includes(e.filename), `shared index contains entry for ${e.filename}`);
  }
  assert.ok(fs.existsSync(path.join(SHARED_DIR_PATH, 'foreign-topic.md')), 'foreign topic file untouched');
  assert.equal(fs.readFileSync(path.join(SHARED_DIR_PATH, 'foreign-topic.md'), 'utf8'), 'foreign content', 'foreign content byte-identical');
});

await test('cross-tool merge: identical-content collision is a no-op (no -opim file created)', async () => {
  fs.rmSync(SHARED_DIR_PATH, { recursive: true, force: true });
  _resetCarryOver();
  // Use the first entry from the local index as our collision candidate
  const localIndexRaw3 = fs.readFileSync(path.join(LEGACY_DIR_PATH, 'MEMORY.md'), 'utf8');
  const localEntries3 = localIndexRaw3.split('\n').map(parseIndexLine).filter(Boolean)
    .filter(e => fs.existsSync(path.join(LEGACY_DIR_PATH, e.filename)));
  const candidate = localEntries3[0];
  const identicalContent = fs.readFileSync(path.join(LEGACY_DIR_PATH, candidate.filename), 'utf8');
  fs.mkdirSync(SHARED_DIR_PATH, { recursive: true });
  // Pre-seed shared dir with the file AND an index entry — simulates another tool already having this content
  fs.writeFileSync(path.join(SHARED_DIR_PATH, 'MEMORY.md'),
    `# Memory Index\n\n- [${candidate.name}](${candidate.filename}) 2026-01-01 -- already here\n`, 'utf8');
  fs.writeFileSync(path.join(SHARED_DIR_PATH, candidate.filename), identicalContent, 'utf8');

  writeRules('{ "shared_dir": true }');
  getMemoryDir();

  const suffixed = candidate.filename.replace(/\.md$/, '-opim.md');
  assert.ok(!fs.existsSync(path.join(SHARED_DIR_PATH, suffixed)), 'no -opim file when content is identical');
  const sharedIndex = fs.readFileSync(path.join(SHARED_DIR_PATH, 'MEMORY.md'), 'utf8');
  assert.equal((sharedIndex.match(new RegExp(candidate.filename.replace('.', '\\.'), 'g')) || []).length, 1,
    'exactly one index entry for the file — no duplicate from the no-op');
});

await test('cross-tool merge: differing-content collision renames local file with -opim suffix', async () => {
  fs.rmSync(SHARED_DIR_PATH, { recursive: true, force: true });
  _resetCarryOver();
  const localTopics = fs.readdirSync(LEGACY_DIR_PATH).filter(f => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'HANDOFF.md');
  const localFilename = localTopics[0];
  const localContent = fs.readFileSync(path.join(LEGACY_DIR_PATH, localFilename), 'utf8');
  const foreignContent = 'completely different content from another tool';
  fs.mkdirSync(SHARED_DIR_PATH, { recursive: true });
  fs.writeFileSync(path.join(SHARED_DIR_PATH, 'MEMORY.md'),
    `# Memory Index\n\n- [Foreign Same Name](${localFilename}) 2026-01-01 -- foreign\n`, 'utf8');
  fs.writeFileSync(path.join(SHARED_DIR_PATH, localFilename), foreignContent, 'utf8'); // same name, different content

  writeRules('{ "shared_dir": true }');
  getMemoryDir();

  const suffixed = localFilename.replace(/\.md$/, '-opim.md');
  assert.ok(fs.existsSync(path.join(SHARED_DIR_PATH, suffixed)), 'local content copied as -opim file');
  assert.equal(fs.readFileSync(path.join(SHARED_DIR_PATH, suffixed), 'utf8'), localContent, '-opim file has local content');
  assert.equal(fs.readFileSync(path.join(SHARED_DIR_PATH, localFilename), 'utf8'), foreignContent, 'original foreign file untouched');
  const sharedIndex = fs.readFileSync(path.join(SHARED_DIR_PATH, 'MEMORY.md'), 'utf8');
  assert.ok(sharedIndex.includes(suffixed), 'shared index entry points to -opim filename');
  assert.ok(sharedIndex.includes(localFilename), 'original foreign entry still in index');
});

await test('cross-tool merge: idempotent on repeat — no -opim-2 or duplicate entries on second run', async () => {
  // Reuse shared dir state from previous test (has both localFilename and -opim file)
  _resetCarryOver();
  const localTopics = fs.readdirSync(LEGACY_DIR_PATH).filter(f => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'HANDOFF.md');
  const suffixed = localTopics[0].replace(/\.md$/, '-opim.md');
  const indexBefore = fs.readFileSync(path.join(SHARED_DIR_PATH, 'MEMORY.md'), 'utf8');
  const filesBefore = fs.readdirSync(SHARED_DIR_PATH);

  writeRules('{ "shared_dir": true }');
  getMemoryDir(); // second run

  const indexAfter = fs.readFileSync(path.join(SHARED_DIR_PATH, 'MEMORY.md'), 'utf8');
  const filesAfter = fs.readdirSync(SHARED_DIR_PATH);
  const bump = localTopics[0].replace(/\.md$/, '-opim-2.md');
  assert.ok(!fs.existsSync(path.join(SHARED_DIR_PATH, bump)), 'no -opim-2 file on repeat run');
  assert.equal(filesAfter.length, filesBefore.length, 'no new files created on repeat run');
  assert.equal((indexAfter.match(new RegExp(suffixed.replace('.', '\\.'), 'g')) || []).length,
    (indexBefore.match(new RegExp(suffixed.replace('.', '\\.'), 'g')) || []).length,
    '-opim entry count unchanged on repeat');
});

await test('cross-tool merge: orphaned local index entry (no backing file) is skipped', async () => {
  fs.rmSync(SHARED_DIR_PATH, { recursive: true, force: true });
  _resetCarryOver();
  // Plant a MEMORY.md entry that points to a missing topic file
  const orphanFilename = 'orphan-topic.md';
  const realLocalIndex = fs.readFileSync(path.join(LEGACY_DIR_PATH, 'MEMORY.md'), 'utf8');
  fs.writeFileSync(path.join(LEGACY_DIR_PATH, 'MEMORY.md'),
    realLocalIndex.trimEnd() + `\n- [Orphan](${orphanFilename}) 2026-01-01 -- orphan\n`, 'utf8');
  // Do NOT create orphan-topic.md

  fs.mkdirSync(SHARED_DIR_PATH, { recursive: true });
  fs.writeFileSync(path.join(SHARED_DIR_PATH, 'MEMORY.md'), '# Memory Index\n\n', 'utf8');
  writeRules('{ "shared_dir": true }');
  getMemoryDir();

  assert.ok(!fs.existsSync(path.join(SHARED_DIR_PATH, orphanFilename)), 'orphaned topic file not created in shared dir');
  const sharedIndex = fs.readFileSync(path.join(SHARED_DIR_PATH, 'MEMORY.md'), 'utf8');
  assert.ok(!sharedIndex.includes(orphanFilename), 'orphaned entry not in shared index');
  // Restore clean local index for subsequent tests
  fs.writeFileSync(path.join(LEGACY_DIR_PATH, 'MEMORY.md'), realLocalIndex, 'utf8');
});

await test('local carry-over runs only once: new legacy-only entries are not retroactively copied', async () => {
  fs.rmSync(SHARED_DIR_PATH, { recursive: true, force: true });
  _resetCarryOver();
  // First carry-over fires here
  writeRules('{ "shared_dir": true }');
  getMemoryDir();
  // Now write new entries to legacy (shared_dir off) — these must NOT appear in shared after re-enabling
  writeRules('{ "shared_dir": false }');
  await executeWriteMemory({ topic: 'Legacy Only Entry', content: 'stays in legacy', summary: 'legacy-only' });
  await executeWriteMemory({ topic: 'Legacy Only Entry 2', content: 'also stays', summary: 'legacy-only-2' });
  writeRules('{ "shared_dir": true }');
  getMemoryDir(); // would re-trigger carry-over if the guard were broken
  assert.ok(!fs.existsSync(path.join(SHARED_DIR_PATH, 'legacy-only-entry.md')), 'not copied — carry-over already ran once');
  assert.ok(!fs.existsSync(path.join(SHARED_DIR_PATH, 'legacy-only-entry-2.md')), 'not copied — carry-over already ran once');
});

await test('lock: concurrent writes are serialized without corrupting the index', async () => {
  writeRules('{ "shared_dir": false }');
  await Promise.all([
    executeWriteMemory({ topic: 'Concurrent A', content: 'a', summary: 'a' }),
    executeWriteMemory({ topic: 'Concurrent B', content: 'b', summary: 'b' }),
  ]);
  const entries = readIndexEntries();
  assert.ok(entries.some(e => e.filename === 'concurrent-a.md'), 'entry A present');
  assert.ok(entries.some(e => e.filename === 'concurrent-b.md'), 'entry B present');
  const raw = readIndex();
  assert.equal((raw.match(/concurrent-a\.md/g) || []).length, 1, 'A appears exactly once — no corrupted duplicate');
  assert.equal((raw.match(/concurrent-b\.md/g) || []).length, 1, 'B appears exactly once — no corrupted duplicate');
});

await test('lock: a stale lock is reclaimed instead of blocking forever', async () => {
  const memoryDir = getMemoryDir();
  const lockPath = path.join(memoryDir, '.lock');
  fs.writeFileSync(lockPath, '999999', { flag: 'w' }); // simulate a crashed holder's lock
  const staleTime = Date.now() / 1000 - 60; // 60s old, well past the 10s staleness threshold
  fs.utimesSync(lockPath, staleTime, staleTime);

  const result = await executeWriteMemory({ topic: 'Stale Lock Test', content: 'x', summary: 'x' });
  assert.ok(result.includes('Stale Lock Test'), 'write completed — stale lock was stolen, not blocked on');
});

await test('atomic write: no leftover temp file after a successful write', async () => {
  await executeWriteMemory({ topic: 'Atomic Check', content: 'x', summary: 'x' });
  const memoryDir = getMemoryDir();
  const leftovers = fs.readdirSync(memoryDir).filter(f => f.includes('.tmp-'));
  assert.equal(leftovers.length, 0, 'no .tmp- files remain');
});

// ═══════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
