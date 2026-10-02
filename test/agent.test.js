'use strict';
// Drives the real agent loop with a scripted model, fake screen, and fake input.

require('./electron-stub');
const intentTest = require('node:test');
const intentAssert = require('node:assert/strict');

intentTest('everyday commands run instantly without the model; anything more goes to it', () => {
  const { matchIntent } = require('../src/main/intents');
  const url = (t) => { const r = matchIntent(t); return r && r.calls[0].input.url; };
  intentAssert.equal(url('Hey Bigfoot, open Chrome and search for nearest hospital'), 'https://www.google.com/search?q=nearest+hospital');
  intentAssert.equal(url('Can you please google best pizza in Lagos?'), 'https://www.google.com/search?q=best+pizza+in+Lagos');
  intentAssert.equal(url('play calm down by rema'), 'https://www.youtube.com/results?search_query=calm+down+by+rema');
  intentAssert.equal(url('go to amazon.com'), 'https://amazon.com');
  intentAssert.deepEqual(matchIntent('open spotify').calls[0], { name: 'open_app', input: { name: 'spotify' } });
  // The search runs now; the rest is handed to the model, starting from the results page.
  const split = matchIntent('open chrome and find the nearest restaurant and browse their menu');
  intentAssert.equal(split.calls[0].input.url, 'https://www.google.com/search?q=the+nearest+restaurant');
  intentAssert.match(split.followUp, /^browse their menu/);
  const song = matchIntent('open chrome and browse the best afrobeat song and download it into my device');
  intentAssert.equal(song.calls[0].input.url, 'https://www.google.com/search?q=the+best+afrobeat+song');
  intentAssert.match(song.followUp, /^download it into my device .*free and legally/);
  intentAssert.equal(url('search for weather in lagos on google'), 'https://www.google.com/search?q=weather+in+lagos');
  for (const t of ['open notepad and write a poem', 'find my resume file', 'what is the weather', 'hi']) intentAssert.equal(matchIntent(t), null, t);
});

intentTest('the calculator gives standard scientific results and errors', () => {
  const { evaluate } = require('../src/main/math');
  const v = (e, o) => evaluate(e, o).text;
  intentAssert.equal(v('sin(30)'), '0.5');
  intentAssert.equal(v('asin(0.5)'), '30');
  intentAssert.equal(v('sin(pi/6)', { angle: 'rad' }), '0.5');
  intentAssert.equal(v('−2^2'), '-4');
  intentAssert.equal(v('2^3^2'), '512');
  intentAssert.equal(v('3×10^(2)'), '300');
  intentAssert.equal(v('5!'), '120');
  for (const [e, msg] of [['tan(90)', /undefined/], ['sqrt(-4)', /real number/], ['log(0)', /greater than 0/], ['1/0', /divide by zero/], ['acos(2)', /between/]]) {
    intentAssert.throws(() => evaluate(e), msg, e);
  }
});
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

intentTest('simple on-screen commands are understood without the model, and only when clear', () => {
  const { matchUiCommand, findElement } = require('../src/main/uicommand');
  intentAssert.deepEqual(matchUiCommand('click Sign in'), { kind: 'click', what: 'Sign in', reply: '' });
  intentAssert.equal(matchUiCommand('Hey Bigfoot, press the Search button').what, 'Search');
  intentAssert.equal(matchUiCommand('scroll down a bit').amount, 3);
  intentAssert.equal(matchUiCommand('press enter').keys, 'enter');
  intentAssert.equal(matchUiCommand('go back').keys, 'alt+left');
  intentAssert.equal(matchUiCommand('click the first result and then download it'), null);
  intentAssert.equal(matchUiCommand('what is on my screen'), null);
  const el = (id, kind, name, x, y, states = '') => ({ id, kind, name, center: { x, y }, states: new Set(states) });
  const snap = { items: [el(0, 'item', 'Images', 100, 50), el(1, 'link', 'Images', 101, 50), el(2, 'button', 'Sign in', 900, 40), el(3, 'button', 'Search', 500, 40), el(4, 'button', 'Search by voice', 560, 40), el(5, 'link', 'Settings', 10, 10, 'd')] };
  intentAssert.equal(findElement(snap, 'images').id, 1); // the link, not the list item around it
  intentAssert.equal(findElement(snap, 'sign in').id, 2);
  intentAssert.equal(findElement(snap, 'search').id, 3); // the exact name wins over "Search by voice"
  intentAssert.equal(findElement(snap, 'settings'), null); // disabled
  intentAssert.equal(findElement(snap, 'download'), null);
});

intentTest('the screen list shows what matters for the task, numbered, in reading order', () => {
  const { ScreenReader } = require('../src/main/screenread');
  const ui = new ScreenReader({ input: null });
  const item = (id, type, name, [x, y, w, h], s = '', value = '') => ({ id, type, kind: { Button: 'button', Hyperlink: 'link', Edit: 'box', ListItem: 'item', Text: 'text', Pane: null }[type] || null,
    name, value, rect: { x, y, w, h }, center: { x: x + w / 2, y: y + h / 2 }, states: new Set(s), writable: s.includes('w') });
  const target = { physicalToSent: (p) => ({ x: p.x / 2, y: p.y / 2 }) };
  const snap = { window: 'best afrobeat songs - Google Search - Google Chrome', app: 'chrome', target, items: [
    item(0, 'Pane', 'Chrome', [0, 0, 1920, 1080]),
    item(1, 'Button', 'Minimize', [1700, 0, 60, 40]),
    item(2, 'Edit', 'Address and search bar', [400, 100, 800, 40], 'w', 'google.com/search?q=afrobeat'),
    item(3, 'ListItem', 'Videos', [600, 300, 100, 60]),
    item(4, 'Hyperlink', 'Videos', [600, 300, 100, 60], 'i', 'https://www.google.com/search?tbm=vid'),
    item(5, 'Hyperlink', 'Burna Boy - Last Last (Official Video)', [300, 500, 600, 40], 'i', 'https://www.youtube.com/watch?v=1'),
    item(6, 'Text', 'Burna Boy - Last Last', [300, 505, 400, 30]),
    item(7, 'Button', 'Sign in', [1800, 100, 80, 40], 'd'),
  ] };
  const text = ui.describe(snap, 'open the youtube video', { limit: 10 });
  intentAssert.match(text, /^On screen: "best afrobeat songs - Google Search - Google Chrome" \(chrome\)\./);
  intentAssert.match(text, /\[5\] link "Burna Boy - Last Last \(Official Video\)" \(youtube\.com\) @300,260/);
  intentAssert.match(text, /\[2\] box "Address and search bar" = "google\.com\/search\?q=afrobeat"/);
  intentAssert.match(text, /\[7\] button "Sign in" \(disabled\)/);
  intentAssert.doesNotMatch(text, /Minimize|\[3\]|\[6\]/); // window buttons and doubles left out
  intentAssert.ok(text.indexOf('[2]') < text.indexOf('[4]') && text.indexOf('[4]') < text.indexOf('[5]'), 'top to bottom');
  intentAssert.deepEqual([...ui.shown.keys()].sort(), [2, 4, 5, 7]);
  // Only the most relevant fit when the list is cut short.
  const short = ui.describe(snap, 'youtube video burna', { limit: 1 });
  intentAssert.match(short, /\[5\]/);
  intentAssert.match(short, /3 more not shown/);
});

intentTest('"the terminal" is Bigfoot\'s own: open it, open a shell in it, or run a command in it', () => {
  const { matchTerminal } = require('../src/main/intents');
  intentAssert.deepEqual(matchTerminal('Hey Bigfoot, open the terminal'), { kind: 'open', shell: null });
  intentAssert.deepEqual(matchTerminal('open command prompt'), { kind: 'open', shell: 'cmd' });
  intentAssert.deepEqual(matchTerminal('run npm install in the terminal'), { kind: 'run', command: 'npm install' });
  intentAssert.deepEqual(matchTerminal('in my terminal, run git status'), { kind: 'run', command: 'git status' });
  for (const t of ['open chrome', 'run the tests', 'what is a terminal']) intentAssert.equal(matchTerminal(t), null, t);
});
