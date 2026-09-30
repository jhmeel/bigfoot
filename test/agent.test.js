'use strict';
// Drives the real agent loop with a scripted model, fake screen, and fake input.

require('./electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const llm = require('../src/main/llm');
const { Agent } = require('../src/main/agent');
const { ComputerExecutor } = require('../src/main/computer');
const { CostTracker } = require('../src/main/costs');
const { PluginRegistry } = require('../src/main/plugins/registry');

/** A provider that replays scripted turns and records what the agent sends back. */
class ScriptedProvider {
  constructor(turns) {
    this.id = 'anthropic';
    this.model = 'scripted';
    this.turns = turns;
    this.user = [];
    this.results = [];
  }
  addUserMessage(text, images = []) { this.user.push({ text, images: images.length }); }
  addToolResults(results) { this.results.push(results); }
  async step() {
    const t = this.turns.shift();
    if (!t) throw new Error('script ran out');
    return { model: 'scripted', usage: { input_tokens: 10, output_tokens: 5 }, progress: [], text: '', calls: [], stop: t.calls ? 'tool_use' : 'end', ...t };
  }
}

function setup({ turns, approvalMode = 'risky', approve = true, onAction } = {}) {
  const values = {
    provider: 'anthropic', model: 'scripted', assistantName: 'Bigfoot', effort: 'high',
    approvalMode, maxTurns: 20, blockedWindowKeywords: 'password',
  };
  const settings = { get: (k) => values[k], secret: (k) => (k === 'anthropicKey' ? 'sk-ant-test' : '') };
  const provider = new ScriptedProvider(turns);
  const original = llm.createProvider;
  llm.createProvider = () => provider;

  const events = { actions: [], approvals: [], moves: [], clicks: [], typed: [], keys: [], draws: [] };
  const input = {
    windowTitle: async () => 'Untitled - Notepad',
    cursor: async () => ({ x: 500, y: 500 }),
    move: async (x, y) => events.moves.push([x, y]),
    click: async (b, n) => events.clicks.push([b, n]),
    type: async (t) => events.typed.push(t),
    keys: async (k) => events.keys.push(k),
    keyDown: async () => {}, keyUp: async () => {}, mouseDown: async () => {}, mouseUp: async () => {}, scroll: async () => {},
  };
  const screen = {
    display: { id: 1 }, sent: { width: 1000, height: 500 },
    screenshot: async () => Buffer.from('png'), zoom: async () => Buffer.from('zoom'),
    checkSent([x, y]) { if (x < 0 || y < 0 || x > 1000 || y > 500) throw new Error('outside'); },
    sentToLocalDip: ([x, y]) => ({ x, y }), sentToPhysical: ([x, y]) => ({ x: x * 2, y: y * 2 }), physicalToSent: (p) => p,
  };
  const plugins = new PluginRegistry();
  plugins.loadBuiltins();
  const agent = new Agent({
    settings, input, plugins, costs: new CostTracker(),
    computer: new ComputerExecutor({ input, pointAt: async () => {} }),
    hooks: {
      state() {}, progress() {}, notice() {}, terminal() {},
      action: (n) => { events.actions.push(n); if (onAction) onAction(n, agent); },
      approve: async (req) => { events.approvals.push(req.title); return approve; },
      draw: (d) => events.draws.push(d),
    },
  });
  agent.setTarget(screen);
  return { agent, provider, events, restore: () => { llm.createProvider = original; } };
}

test('clicks, types, and answers', async () => {
  const { agent, provider, events, restore } = setup({
    turns: [
      { calls: [{ id: 'a', name: 'left_click', input: { coordinate: [100, 50] }, computer: true }, { id: 'b', name: 'type', input: { text: 'hello' }, computer: true }] },
      { text: 'Typed hello for you.' },
    ],
  });
  try {
    const r = await agent.run('type hello');
    assert.equal(r.status, 'done');
    assert.equal(r.text, 'Typed hello for you.');
    assert.deepEqual(events.moves, [[200, 100]]);
    assert.deepEqual(events.clicks, [['left', 1]]);
    assert.deepEqual(events.typed, ['hello']);
    const [results] = provider.results;
    assert.equal(results.length, 2);
    assert.ok(Array.isArray(results[1].content), 'a screenshot is attached after the batch');
    assert.equal(results[1].content[1].type, 'image');
  } finally { restore(); }
});

test('risky keys ask first, and a decline stops the rest of the batch', async () => {
  const { agent, provider, events, restore } = setup({
    approve: false,
    turns: [
      { calls: [{ id: 'a', name: 'key', input: { text: 'Return' }, computer: true }, { id: 'b', name: 'type', input: { text: 'x' }, computer: true }] },
      { text: 'Okay, I won’t.' },
    ],
  });
  try {
    await agent.run('press enter');
    assert.deepEqual(events.approvals, ['Allow this action?']);
    assert.deepEqual(events.keys, []);
    const [results] = provider.results;
    assert.match(results[0].content, /declined/);
    assert.match(results[1].content, /earlier action/);
  } finally { restore(); }
});

test('file plugins create, read, and recycle files with the right approvals', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigfoot-'));
  const file = path.join(dir, 'notes', 'todo.txt');
  const { agent, provider, events, restore } = setup({
    turns: [
      { calls: [{ id: '1', name: 'write_file', input: { path: file, content: 'buy milk' } }] },
      { calls: [{ id: '2', name: 'read_file', input: { path: file } }] },
      { calls: [{ id: '3', name: 'delete_path', input: { path: file } }] },
      { text: 'Done.' },
    ],
  });
  try {
    await agent.run('make a note');
    assert.equal(fs.existsSync(file), true, 'the stubbed Recycle Bin leaves the file');
    assert.match(provider.results[1][0].content, /buy milk/);
    assert.deepEqual(events.approvals, ['Move this file to the Recycle Bin?'], 'deletes always ask; creating does not in risky mode');
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('annotate draws on the overlay in screen coordinates', async () => {
  const { agent, events, restore } = setup({
    turns: [
      { calls: [{ id: '1', name: 'annotate', input: { shape: 'box', points: [[10, 20], [110, 60]], label: 'Save', color: 'red' } }] },
      { text: 'That’s the save button.' },
    ],
  });
  try {
    await agent.run('where is save?');
    assert.equal(events.draws.length, 1);
    assert.equal(events.draws[0].shape, 'box');
    assert.equal(events.draws[0].color, 'red');
    assert.deepEqual(events.draws[0].points, [{ x: 10, y: 20 }, { x: 110, y: 60 }]);
  } finally { restore(); }
});

test('Esc mid-batch stops and still answers every call', async () => {
  const { agent, provider, restore } = setup({
    onAction: (name, a) => { if (name === 'left_click') a.stop(); },
    turns: [{ calls: [
      { id: 'a', name: 'left_click', input: { coordinate: [1, 1] }, computer: true },
      { id: 'b', name: 'type', input: { text: 'x' }, computer: true },
    ] }],
  });
  try {
    const r = await agent.run('click');
    assert.equal(r.status, 'stopped');
    const [results] = provider.results;
    assert.equal(results.length, 2);
    assert.ok(results.every((x) => x.isError));
  } finally { restore(); }
});

test('coordinates outside the screenshot are rejected before anything moves', async () => {
  const { agent, provider, events, restore } = setup({
    turns: [
      { calls: [{ id: 'a', name: 'left_click', input: { coordinate: [5000, 10] }, computer: true }] },
      { text: 'Sorry.' },
    ],
  });
  try {
    await agent.run('click far away');
    assert.deepEqual(events.clicks, []);
    assert.match(provider.results[0][0].content, /outside/);
  } finally { restore(); }
});

test('a traced outline is drawn onto the screenshot sent with the question', async () => {
  const { agent, provider, restore } = setup({ turns: [{ text: 'That is the Save button.' }] });
  let marked = null;
  agent.hooks.markImage = async (png, points) => { marked = points; return Buffer.from('marked'); };
  try {
    const r = await agent.run('what is this?', { region: { x0: 10, y0: 10, x1: 60, y1: 40, points: [[10, 10], [60, 12], [58, 40], [12, 38]] } });
    assert.equal(r.text, 'That is the Save button.');
    assert.equal(marked.length, 4);
    assert.equal(provider.user[0].images, 2);
    assert.match(provider.user[0].text, /outlined in blue/);
  } finally { restore(); }
});
