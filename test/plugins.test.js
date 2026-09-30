'use strict';

require('./electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { inspectPlugin } = require('../src/main/plugins/validate');
const { PluginRegistry } = require('../src/main/plugins/registry');
const { PluginManager } = require('../src/main/plugins/manage');
const { TEMPLATE } = require('../src/main/plugins/template');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigfoot-plugins-'));
const write = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src); return f; };
const tool = (name, extra = '') => `module.exports = { name: '${name}', description: 'Does a useful thing when the user asks for it.', input_schema: { type: 'object', properties: { a: { type: 'string', description: 'An input.' } }, required: ['a'] }, async run(i) { return i.a; } ${extra} };`;

test('the template passes validation and reports what it can reach', async () => {
  const r = await inspectPlugin(write('template.js', TEMPLATE), { execPath: process.execPath });
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual(r.tools.map((t) => t.name), ['word_count']);
  assert.ok(r.capabilities.includes('Read, change, and delete files'));
  assert.deepEqual(r.warnings, []);
});

test('broken plugins are rejected with a reason, before anything runs in Bigfoot', async () => {
  const opts = { execPath: process.execPath, timeoutMs: 2000 };
  const syntax = await inspectPlugin(write('syntax.js', 'module.exports = { name: '), opts);
  assert.match(syntax.errors[0], /Syntax error/);

  const clash = await inspectPlugin(write('clash.js', tool('open_app')), { ...opts, existing: new Map([['open_app', 'built in']]) });
  assert.match(clash.errors.join(), /already exists \(built in\)/);

  const schema = await inspectPlugin(write('schema.js', `module.exports = { name: 'bad_schema', description: 'A tool with a broken input schema for testing.', input_schema: { type: 'object', properties: { list: { type: 'array' }, n: { type: 'numbr' } }, required: ['missing'] }, run() {} };`), opts);
  assert.equal(schema.ok, false);
  assert.match(schema.errors.join('\n'), /"missing" isn't listed/);
  assert.match(schema.errors.join('\n'), /"list" needs "items"/);
  assert.match(schema.errors.join('\n'), /unknown type "numbr"/);
  assert.match(schema.warnings.join('\n'), /isn’t async/);

  const noRun = await inspectPlugin(write('norun.js', `module.exports = { name: 'no_run', description: 'Missing its run function entirely.', input_schema: { type: 'object' } };`), opts);
  assert.match(noRun.errors.join(), /run\(input, ctx\)/);

  const hangs = await inspectPlugin(write('hangs.js', 'while (true) {}'), opts);
  assert.match(hangs.errors.join(), /longer than 2 seconds/);

  const throws = await inspectPlugin(write('throws.js', "throw new Error('boom')"), opts);
  assert.match(throws.errors.join(), /threw while loading: boom/);

  const txt = await inspectPlugin(write('notes.txt', tool('x_tool')), opts);
  assert.match(txt.errors.join(), /must be \.js/);
});

test('installing and removing a plugin updates the tools and the list', async () => {
  const registry = new PluginRegistry();
  registry.loadBuiltins();
  const userDir = path.join(dir, 'installed');
  const pm = new PluginManager({ registry, dir: userDir });
  pm.ensureFolder();
  assert.ok(fs.existsSync(path.join(userDir, 'README.txt')));
  const before = registry.version;

  const res = await pm.install(write('greet.js', tool('greet_user')));
  assert.equal(res.ok, true, JSON.stringify(res.report.errors));
  assert.ok(registry.has('greet_user'));
  assert.ok(registry.version > before);
  const listed = pm.list();
  assert.deepEqual(listed.custom, [{ file: 'greet.js', tools: ['greet_user'], error: '' }]);
  assert.ok(listed.builtin.some((g) => g.title === 'Edit your drawing' && g.tools.includes('edit_drawing')));

  const again = await pm.install(path.join(userDir, 'greet.js')); // reinstalling the same file is an update, not a clash
  assert.equal(again.ok, true);

  await pm.remove('greet.js', async (p) => fs.promises.rm(p));
  assert.ok(!registry.has('greet_user'));
  assert.deepEqual(pm.list().custom, []);
});

test('edit_drawing draws ready pictures from a subject', async () => {
  const drawing = require('../src/main/plugins/builtin/drawing');
  const { pictureName } = require('../src/main/plugins/lib/pictures');
  assert.equal(pictureName('a bird'), 'bird');
  assert.equal(pictureName('smiley face'), 'smiley');
  assert.equal(pictureName('a flying dragon'), null);
  const ops = [];
  const ctx = {
    screen: { sentToLocalDip: ([x, y]) => ({ x, y }), display: { bounds: { width: 1000, height: 800 } } },
    ink: async (op) => { ops.push(op); return true; },
  };
  const said = await drawing.run({ action: 'add', shape: 'picture', subject: 'bird' }, ctx);
  assert.equal(said, 'Drew a bird.');
  assert.ok(ops.length > 4 && ops.every((o) => o.op === 'add' && o.stroke.points.length >= 2));
  const xs = ops.flatMap((o) => o.stroke.points.map((p) => p.x));
  assert.ok(Math.min(...xs) >= 372 && Math.max(...xs) <= 628); // centered, fitted in the default box
  await assert.rejects(drawing.run({ action: 'add', shape: 'picture', subject: 'dragon' }, ctx), /No ready picture/);
});
