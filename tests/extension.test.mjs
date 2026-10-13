/**
 * Host-load smoke test for the openpi-memory extension wiring (extensions/index.ts).
 *
 * Unlike tests/core.test.mjs (which tests memory-core.mjs directly), this test
 * loads the actual TypeScript extension through pi's real loader and confirms:
 *   1. The module compiles/loads with no errors or load warnings against the installed pi version.
 *   2. The default factory executes and registers the expected event handlers,
 *      tools, and command.
 *   3. The session_start handler bootstraps the memory files on disk.
 *   4. The before_agent_start handler injects the memory index into the system prompt.
 *      Section 7 below additionally checks, on pi >=0.99, that none of our tool/command names
 *      shadow one of pi's built-in extensions (replacement-warning path in DefaultResourceLoader),
 *      with a positive control proving the check itself fires.
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

import { Type } from 'typebox';
import { DefaultResourceLoader, VERSION as PI_VERSION, discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';

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
// Pin the pi >=0.99 load-warning shape. The standalone loader leaves `warnings` empty (only the
// resource loader fills it), so the real collision guard is section 7 below.
assert.deepEqual(result.warnings ?? [], [], `extension emitted load warnings: ${JSON.stringify(result.warnings)}`);
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

// 4. session_start creates config, keeping missing index reads read-only.
await ok('session_start creates config without an unlocked index write', async () => {
  for (const h of ext.handlers.get('session_start') ?? []) await h();
  assert.ok(!fs.existsSync(path.join(AGENT_DIR, 'memory', 'MEMORY.md')), 'index should only be created by a locked mutation');
  assert.ok(fs.existsSync(path.join(AGENT_DIR, 'memory.jsonc')), 'memory.jsonc not created');
});

// 5. before_agent_start injects the memory index into the system prompt
await ok('before_agent_start injects memory into the system prompt', async () => {
  const outputs = [];
  for (const h of ext.handlers.get('before_agent_start') ?? []) {
    outputs.push(await h({ type: 'before_agent_start', messageType: 'user', prompt: 'Hello', systemPrompt: 'BASE_PROMPT' }));
  }
  const injected = outputs.map((o) => o?.systemPrompt ?? '').join('\n');
  assert.ok(injected.startsWith('BASE_PROMPT'), 'base system prompt was not preserved');
  assert.ok(injected.includes('## Global Memory'), 'memory index section not injected');
});

// 6. Injection stays scheduled by user prompts on both old and new event shapes.
// Invoke the real loaded handlers with controlled events: older pi lacks messageType;
// pi >=1.2 also emits custom events for extension-triggered runs.
async function resetInjection() {
  for (const h of ext.handlers.get('session_start') ?? []) await h();
}

async function runBeforeAgentStart(messageType = 'user') {
  const event = {
    type: 'before_agent_start',
    systemPrompt: 'BASE_PROMPT',
    ...(messageType === 'custom'
      ? { messageType, message: { role: 'custom', customType: 'test', content: 'Continue', display: false } }
      : { prompt: 'Hello', ...(messageType === null ? {} : { messageType }) }),
  };
  const outputs = [];
  for (const h of ext.handlers.get('before_agent_start') ?? []) outputs.push(await h(event));
  return outputs.find((o) => o?.systemPrompt !== undefined);
}

await ok('injects on the first and every fifth user prompt', async () => {
  await resetInjection();
  const injected = [];
  for (let i = 0; i < 6; i++) injected.push(!!(await runBeforeAgentStart()));
  assert.deepEqual(injected, [true, false, false, false, true, false]);
});

await ok('preserves injection for legacy events without messageType', async () => {
  await resetInjection();
  const injected = [];
  // null selects the legacy shape without being replaced by the helper's default.
  for (let i = 0; i < 6; i++) injected.push(!!(await runBeforeAgentStart(null)));
  assert.deepEqual(injected, [true, false, false, false, true, false]);
});

await ok('custom runs neither inject nor advance the user-prompt interval', async () => {
  await resetInjection();
  const injected = [];
  for (const type of ['custom', 'user', 'custom', 'user', 'user', 'custom', 'user', 'user']) {
    injected.push(!!(await runBeforeAgentStart(type)));
  }
  assert.deepEqual(injected, [false, true, false, false, false, false, false, true]);
});

await ok('custom runs leave the startup handoff for the first user prompt', async () => {
  const handoffPath = path.join(AGENT_DIR, 'HANDOFF.md');
  fs.writeFileSync(handoffPath, '## Test handoff\n\nStartup orientation.\n');
  try {
    await resetInjection();
    assert.equal(await runBeforeAgentStart('custom'), undefined);
    const first = await runBeforeAgentStart();
    assert.ok(first?.systemPrompt.includes('Startup orientation.'), 'first user prompt must receive the handoff');
    for (let i = 0; i < 3; i++) await runBeforeAgentStart();
    const next = await runBeforeAgentStart();
    assert.ok(next?.systemPrompt.includes('## Global Memory'));
    assert.ok(!next.systemPrompt.includes('## Compaction Handoff'), 'handoff must be consumed only once');
  } finally { fs.rmSync(handoffPath, { force: true }); }
});

await ok('custom runs preserve post-compaction reinjection and handoff', async () => {
  const handoffPath = path.join(AGENT_DIR, 'HANDOFF.md');
  try {
    await resetInjection();
    await runBeforeAgentStart();
    for (const h of ext.handlers.get('session_before_compact') ?? []) {
      await h({
        reason: 'manual',
        preparation: { messagesToSummarize: [{ role: 'assistant', content: [{ type: 'text', text: 'Post-compaction orientation.' }] }] },
      });
    }
    assert.equal(await runBeforeAgentStart('custom'), undefined);
    const next = await runBeforeAgentStart();
    assert.ok(next?.systemPrompt.includes('## Global Memory'), 'first user prompt after compaction must reinject');
    assert.ok(next.systemPrompt.includes('Post-compaction orientation.'), 'custom run must not consume the handoff');
  } finally { fs.rmSync(handoffPath, { force: true }); }
});

// 7. Built-in name-collision sentinel (pi >=0.99)
// pi >=0.99 drops a replaceable built-in extension and pushes a load warning when another
// extension registers the same tool/command/flag name. Only DefaultResourceLoader produces those
// warnings, so drive it with stand-ins claiming the resource names pi's own built-ins use today
// (`/mcp`, `/llama`, `codemode`, `tool_search`), plus a positive control proving the sentinel fires.

const [piMajor, piMinor] = PI_VERSION.split('.').map(Number);
const piReportsBuiltinReplacement = piMajor > 0 || (piMajor === 0 && piMinor >= 99);

const standInCommand = (name) => ({
  name,
  builtin: true,
  replaceable: true,
  factory: (pi) => {
    pi.registerCommand(name, { description: `stand-in built-in /${name}`, handler: async () => {} });
  },
});

const standInTool = (name) => ({
  name,
  builtin: true,
  replaceable: true,
  factory: (pi) => {
    pi.registerTool({
      name,
      label: name,
      description: `stand-in built-in ${name}`,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text: name }], details: {} };
      },
    });
  },
});

async function loadWithBuiltIns(extensionFactories) {
  const loader = new DefaultResourceLoader({
    cwd: CWD,
    agentDir: AGENT_DIR,
    additionalExtensionPaths: [extIndex],
    extensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader.getExtensions();
}

if (!piReportsBuiltinReplacement) {
  console.log(`  SKIP  built-in collision sentinel (needs pi >=0.99, running ${PI_VERSION})`);
} else {
  await ok('keeps the built-in resource names of current pi free', async () => {
    const res = await loadWithBuiltIns([
      standInCommand('mcp'),
      standInCommand('llama'),
      standInTool('codemode'),
      standInTool('tool_search'),
    ]);
    assert.deepEqual(res.errors, [], `unexpected load errors: ${JSON.stringify(res.errors)}`);
    assert.deepEqual(res.warnings ?? [], [], `our extension replaced a built-in: ${JSON.stringify(res.warnings)}`);
    assert.ok(res.extensions.some((e) => e.commands.has('memory')), '/memory must stay registered');
  });

  await ok('collision sentinel reports a taken built-in name', async () => {
    const res = await loadWithBuiltIns([standInCommand('memory')]);
    const warnings = res.warnings ?? [];
    assert.equal(warnings.length, 1, `expected one replacement warning, got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0].warning, /command `\/memory`/, `unexpected warning text: ${warnings[0].warning}`);
  });
}

console.log(`\n${passed} checks: ${passed} passed, 0 failed`);
