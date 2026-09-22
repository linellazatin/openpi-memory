/**
 * Host-load smoke test for the openpi-memory extension wiring (extensions/index.ts).
 *
 * Unlike tests/core.test.mjs (which tests memory-core.mjs directly), this test
 * loads the actual TypeScript extension through pi's real loader and confirms:
 *   1. The module compiles/loads with no errors against the installed pi version.
 *   2. The default factory executes and registers the expected event handlers,
 *      tools, and command.
 *   3. The session_start handler bootstraps the memory files on disk.
 *   4. The before_agent_start handler injects the memory index into the system prompt.
 *
 * STATE ISOLATION: PI_CODING_AGENT_DIR and PI_SHARED_MEMORY_HOME are pointed at
 * temp dirs BEFORE loading the extension, because memory-core.mjs fixes AGENT_DIR
 * at import time. The pi loader's discovery roots (cwd + agentDir) are also temp
 * dirs so no real global/project extensions are loaded alongside ours.
 */

import assert from 'assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';

// ── Temp-dir isolation (before any extension/module load) ───────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpi-memory-extension-'));
const CWD = path.join(TMP, 'cwd');
const AGENT_DIR = path.join(TMP, 'agent');
const SHARED_HOME = path.join(TMP, 'shared-home');
fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(AGENT_DIR, { recursive: true });
fs.mkdirSync(SHARED_HOME, { recursive: true });

process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_SHARED_MEMORY_HOME = SHARED_HOME;

process.on('exit', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── Load the real extension through pi's loader ─────────────────────────────

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const extIndex = path.join(repoRoot, 'extensions', 'index.ts');

const result = await discoverAndLoadExtensions([extIndex], CWD, AGENT_DIR);

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

assert.deepEqual(result.errors, [], `extension failed to load: ${JSON.stringify(result.errors)}`);
assert.equal(result.extensions.length, 1, 'expected exactly one loaded extension');

const ext = result.extensions[0];

// 1. Registered event handlers
for (const evt of ['session_start', 'before_agent_start', 'session_before_compact', 'session_compact']) {
  await ok(`registers ${evt} handler`, () => {
    assert.ok(ext.handlers.get(evt)?.length >= 1, `missing ${evt} handler`);
  });
}

// 2. Registered tools
for (const name of ['write_memory', 'remove_memory', 'pin_memory']) {
  await ok(`registers ${name} tool`, () => {
    assert.ok(ext.tools.has(name), `missing ${name} tool`);
  });
}

// 3. Registered command
await ok('registers /memory command', () => {
  assert.ok(ext.commands.has('memory'), 'missing /memory command');
});

// 4. session_start bootstraps the memory store
await ok('session_start bootstraps MEMORY.md and memory.jsonc', async () => {
  for (const h of ext.handlers.get('session_start') ?? []) await h();
  assert.ok(fs.existsSync(path.join(AGENT_DIR, 'memory', 'MEMORY.md')), 'MEMORY.md not created');
  assert.ok(fs.existsSync(path.join(AGENT_DIR, 'memory.jsonc')), 'memory.jsonc not created');
});

// 5. before_agent_start injects the memory index into the system prompt
await ok('before_agent_start injects memory into the system prompt', async () => {
  const outputs = [];
  for (const h of ext.handlers.get('before_agent_start') ?? []) {
    outputs.push(await h({ systemPrompt: 'BASE_PROMPT' }));
  }
  const injected = outputs.map((o) => o?.systemPrompt ?? '').join('\n');
  assert.ok(injected.startsWith('BASE_PROMPT'), 'base system prompt was not preserved');
  assert.ok(injected.includes('## Global Memory'), 'memory index section not injected');
});

console.log(`\n${passed} checks: ${passed} passed, 0 failed`);