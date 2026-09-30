'use strict';

require('./electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { costOf, CostTracker, BudgetExceeded } = require('../src/main/costs');
const { comboToVks, splitCombo } = require('../src/main/input');
const { extractPoint } = require('../src/main/agent');
const { echoContent } = require('../src/main/llm/anthropic');
const { toComputerCall, portableSchema, computerFunction } = require('../src/main/llm/computer-schema');
const { resolveProvider } = require('../src/main/llm');
const { isRisky } = require('../src/main/computer');
const { fitSize, ScreenTarget } = require('../src/main/capture');
const { PluginRegistry } = require('../src/main/plugins/registry');
const { resolvePath, assertWritable } = require('../src/main/plugins/lib/paths');
const { scoreApp } = require('../src/main/plugins/builtin/apps');
const { cleanName } = require('../src/main/settings');
const { systemPrompt } = require('../src/main/prompt');

test('costs use list prices and every billed fallback attempt', () => {
  const one = costOf('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000 });
  assert.equal(one.cost.toFixed(2), '6.20'); // 4 + 2 + 0.20
  const fallback = costOf('claude-opus-5-5', {
    input_tokens: 10, output_tokens: 10,
    iterations: [
      { model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0 },
      { model: 'claude-sonnet-5-5', input_tokens: 1_000_000, output_tokens: 0 },
    ],
  });
  assert.equal(fallback.cost.toFixed(2), '6.00');
  assert.equal(costOf('mystery-model', { input_tokens: 1_000_000 }).cost, 10); // unknown = highest rate
});

test('spending limit stops a task', () => {
  const t = new CostTracker();
  t.record('claude-opus-5-5', { input_tokens: 600_000 });
  assert.throws(() => t.check(2), BudgetExceeded);
  assert.doesNotThrow(() => t.check(0));
});

test('key combos map to virtual-key codes', () => {
  assert.deepEqual(comboToVks('ctrl+shift+t'), [0x11, 0x10, 0x54]);
  assert.deepEqual(comboToVks('Return'), [0x0d]);
  assert.deepEqual(comboToVks('super'), [0x5b]);
  assert.deepEqual(comboToVks('cmd+l'), [0x11, 0x4c]);
  assert.deepEqual(comboToVks('F5'), [0x74]);
  assert.deepEqual(splitCombo('ctrl++'), ['ctrl', '+']);
  assert.deepEqual(comboToVks('ctrl++'), [0x11, 0x10, 0xbb]);
  assert.throws(() => comboToVks('hyper'), /Unknown key/);
});

test('refusal fallback echo keeps only text before the last switch', () => {
  const content = [
    { type: 'thinking', thinking: '' }, { type: 'text', text: 'a' }, { type: 'tool_use', id: '1' },
    { type: 'fallback' }, { type: 'text', text: 'b' }, { type: 'tool_use', id: '2' },
  ];
  assert.deepEqual(echoContent(content).map((b) => b.type), ['text', 'fallback', 'text', 'tool_use']);
  const plain = [{ type: 'text', text: 'x' }];
  assert.deepEqual(echoContent(plain), plain);
});

test('POINT tags are parsed and stripped from replies', () => {
  const r = extractPoint('The save button is here [POINT:120,45:save] on the toolbar.');
  assert.deepEqual(r.point, { x: 120, y: 45, label: 'save' });
  assert.equal(r.text, 'The save button is here on the toolbar.');
  assert.equal(extractPoint('no tag').point, null);
});

test('risky keys and multi-line typing need approval', () => {
  assert.ok(isRisky('key', { text: 'Return' }));
  assert.ok(isRisky('key', { text: 'alt+F4' }));
  assert.ok(isRisky('key', { text: 'ctrl+w' }));
  assert.ok(isRisky('type', { text: 'hello\n' }));
  assert.ok(!isRisky('key', { text: 'ctrl+t' }));
  assert.ok(!isRisky('left_click', { coordinate: [1, 1] }));
});

test('screenshots fit the long-edge cap and the visual token budget', () => {
  const s = fitSize(3840, 2160, 1366);
  assert.equal(s.width, 1366);
  assert.ok(Math.ceil(s.width / 28) * Math.ceil(s.height / 28) <= 4784);
  const big = fitSize(5120, 2880, 5000);
  assert.ok(big.width <= 2576 && Math.ceil(big.width / 28) * Math.ceil(big.height / 28) <= 4784);
});

test('screenshot coordinates map to the right display, including offsets', () => {
  const t = new ScreenTarget({ id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }, 1366);
  assert.deepEqual(t.sentToPhysical([t.sent.width, t.sent.height]), { x: 3839, y: 1079 }); // last pixel on this display
  assert.deepEqual(t.sentToPhysical([0, 0]), { x: 1920, y: 0 });
  assert.throws(() => t.checkSent([t.sent.width + 1, 0]), /outside/);
  assert.deepEqual(t.physicalToSent({ x: 1920 + 960, y: 540 }), { x: Math.round(t.sent.width / 2), y: Math.round(t.sent.height / 2) });
});

test('plugin registry validates, orders, and runs tools', async () => {
  const reg = new PluginRegistry();
  reg.register({ name: 'zeta_tool', description: 'Does zeta things.', input_schema: { type: 'object', properties: {}, required: [] }, run: async () => 'z' });
  reg.register({ name: 'alpha_tool', description: 'Does alpha things.', input_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, run: async (i) => i.a });
  assert.deepEqual(reg.definitions().map((d) => d.name), ['alpha_tool', 'zeta_tool']);
  assert.ok(!('run' in reg.definitions()[0]));
  assert.equal(await reg.run('alpha_tool', { a: 'hi' }, {}), 'hi');
  await assert.rejects(reg.run('alpha_tool', {}, {}), /Missing required input: a/);
  assert.throws(() => reg.register({ name: 'Bad Name', description: 'x'.repeat(20), input_schema: { type: 'object' }, run() {} }), /name must match/);
  assert.throws(() => reg.register({ name: 'screenshot', description: 'x'.repeat(20), input_schema: { type: 'object' }, run() {} }), /reserved/);
  assert.throws(() => reg.register({ name: 'alpha_tool', description: 'x'.repeat(20), input_schema: { type: 'object' }, run() {} }), /clashes/);
});

test('built-in plugins load and declare valid schemas', () => {
  const reg = new PluginRegistry();
  reg.loadBuiltins();
  const names = reg.definitions().map((d) => d.name);
  for (const n of ['annotate', 'edit_drawing', 'open_app', 'open_url', 'run_command', 'list_directory', 'read_file', 'write_file', 'create_folder', 'delete_path', 'open_path']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

test('paths resolve shortcuts and refuse system locations', () => {
  assert.equal(resolvePath('Desktop/notes.txt'), path.join(os.homedir(), 'Desktop', 'notes.txt'));
  assert.equal(resolvePath('~/a.txt'), path.join(os.homedir(), 'a.txt'));
  assert.throws(() => assertWritable('C:\\Windows\\System32\\drivers'), /system folders/);
  assert.throws(() => assertWritable('C:\\'), /root of a drive/);
  assert.throws(() => assertWritable(os.homedir()), /home folder/);
  assert.doesNotThrow(() => assertWritable(path.join(os.homedir(), 'Documents', 'x.txt')));
});

test('app names match what people say', () => {
  assert.ok(scoreApp('chrome', 'Google Chrome') >= 80);
  assert.ok(scoreApp('notepad', 'Notepad') === 100);
  assert.ok(scoreApp('word', 'Word') > scoreApp('word', 'WordPad'));
  assert.equal(scoreApp('zzz', 'Calculator'), 0);
});

test('assistant names are cleaned to something you can say', () => {
  assert.equal(cleanName('  nova  '), 'nova');
  assert.equal(cleanName('Zoë-Anne'), 'Zoë-Anne');
  assert.equal(cleanName('X'), '');
  assert.equal(cleanName('Jarvis!!!'), 'Jarvis');
  assert.ok(systemPrompt('Nova').includes('You are Nova'));
  assert.equal(systemPrompt('Nova'), systemPrompt('Nova')); // byte-stable for caching
});

test('providers without a native computer tool use one "computer" function', () => {
  assert.deepEqual(toComputerCall({ action: 'left_click', coordinate: [5, 6] }), { name: 'left_click', input: { coordinate: [5, 6] } });
  assert.throws(() => toComputerCall({ action: 'explode' }), /Unknown computer action/);
  const fn = computerFunction(1366, 768);
  assert.match(fn.description, /1366x768/);
  const cleaned = portableSchema({ type: 'object', additionalProperties: false, properties: { p: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } } } });
  assert.deepEqual(cleaned, { type: 'object', properties: { p: { type: 'array', items: { type: 'number' } } } });
});

test('the local model is the default, cloud is used only when chosen, keyed, and online', () => {
  const fake = (provider, keys, localModel = '') => ({
    get: (k) => ({ provider, localModel })[k],
    secret: (k) => keys[k] || '',
  });
  const installed = 'qwen3-vl-8b';
  assert.equal(resolveProvider(fake('local', { anthropicKey: 'a' }, installed)), 'local');
  assert.equal(resolveProvider(fake('anthropic', { anthropicKey: 'a' }, installed)), 'anthropic');
  assert.equal(resolveProvider(fake('anthropic', { anthropicKey: 'a' }, installed), { online: false }), 'local');
  assert.equal(resolveProvider(fake('openai', {}, installed)), 'local'); // chosen cloud without a key
  assert.equal(resolveProvider(fake('local', { openaiKey: 'o' })), 'openai'); // model still downloading
  assert.equal(resolveProvider(fake('local', {})), null);
  assert.equal(resolveProvider(fake('local', {}, 'not-a-model')), null);
});
