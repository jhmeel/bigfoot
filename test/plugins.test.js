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
  assert.equal(ops.length, 1);
  assert.ok(ops[0].strokes.length > 4 && ops[0].strokes.every((s) => s.points.length >= 2));
  const xs = ops[0].strokes.flatMap((s) => s.points.map((p) => p.x));
  assert.ok(Math.min(...xs) >= 372 && Math.max(...xs) <= 628); // centered, fitted in the default box
  await assert.rejects(drawing.run({ action: 'add', shape: 'picture', subject: 'zzqx blorp' }, ctx), /No picture of/);
});

function drawCtx() {
  const ops = [];
  return {
    ops,
    screen: { sentToLocalDip: ([x, y]) => ({ x, y }), display: { bounds: { width: 1000, height: 800 } } },
    ink: async (op) => { ops.push(op); return op.strokes ? op.strokes.length : 2; },
  };
}

test('edit_drawing draws any of thousands of icons, in one undo step', async () => {
  const drawing = require('../src/main/plugins/builtin/drawing');
  const { searchIcons, iconCount } = require('../src/main/plugins/lib/icons');
  assert.ok(iconCount() > 4000);
  assert.equal(searchIcons('rocket')[0], 'rocket');
  assert.equal(searchIcons('a coffee')[0], 'coffee');
  const ctx = drawCtx();
  assert.equal(await drawing.run({ action: 'add', shape: 'picture', subject: 'rocket', points: [[100, 100], [300, 300]] }, ctx), 'Drew a rocket.');
  assert.equal(ctx.ops.length, 1); // one message, one undo step
  const pts = ctx.ops[0].strokes.flatMap((s) => s.points);
  assert.ok(pts.every((p) => p.x >= 99 && p.x <= 301 && p.y >= 99 && p.y <= 301));
  await assert.rejects(drawing.run({ action: 'add', shape: 'picture', subject: 'zzqx' }, ctx), /shape "svg"/);
});

test('edit_drawing draws SVG the model writes, with colors and fills', async () => {
  const drawing = require('../src/main/plugins/builtin/drawing');
  const ctx = drawCtx();
  const svg = '<svg viewBox="0 0 100 50"><rect x="0" y="10" width="40" height="40" fill="red"/><circle cx="75" cy="25" r="20" stroke="#123456" fill="none"/><g stroke="green"><line x1="0" y1="0" x2="100" y2="0"/></g></svg>';
  await drawing.run({ action: 'add', shape: 'svg', svg, points: [[0, 0], [200, 100]] }, ctx);
  const [rect, circle, line] = ctx.ops[0].strokes;
  assert.equal(rect.fill, '#ff453a');
  assert.equal(rect.noStroke, true); // filled and no stroke: no outline, as in SVG
  assert.equal(circle.color, '#123456');
  assert.equal(circle.fill, undefined);
  assert.equal(line.color, '#32d74b');
  assert.ok(Math.abs(Math.max(...circle.points.map((p) => p.x)) - 190) < 1); // scaled ×2 into the box
  await assert.rejects(drawing.run({ action: 'add', shape: 'svg', svg: '<svg><script>x</script></svg>' }, ctx), /plain shapes/);
  await assert.rejects(drawing.run({ action: 'add', shape: 'svg', svg: '<svg></svg>' }, ctx), /no shapes/);
});

test('tidy turns rough shapes into perfect ones and leaves writing alone', async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/renderer/overlay-ink.js'), 'utf8');
  const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
  // eslint-disable-next-line no-new-func
  const recognize = new Function(`${grab('function distToSegment', 'const textSize')}${grab('function simplify', 'function tidied')}return recognize;`)();
  let seed = 42;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const jit = (x, y, a = 6) => ({ x: x + rnd() * a, y: y + rnd() * a });
  const circle = Array.from({ length: 60 }, (_, i) => jit(200 + 80 * Math.cos(0.3 + (i / 58) * 6.28), 200 + 80 * Math.sin(0.3 + (i / 58) * 6.28)));
  const box = [];
  const corners = [[100, 100], [300, 100], [300, 220], [100, 220], [102, 103]];
  for (let k = 0; k < 4; k++) for (let i = 0; i < 15; i++) box.push(jit(corners[k][0] + ((corners[k + 1][0] - corners[k][0]) * i) / 15, corners[k][1] + ((corners[k + 1][1] - corners[k][1]) * i) / 15));
  const round = recognize(circle);
  const cx = (Math.min(...round.map((p) => p.x)) + Math.max(...round.map((p) => p.x))) / 2;
  const cy = (Math.min(...round.map((p) => p.y)) + Math.max(...round.map((p) => p.y))) / 2;
  const r = Math.hypot(round[0].x - cx, round[0].y - cy);
  assert.ok(round.length > 60 && Math.abs(r - 80) < 6 && round.every((p) => Math.abs(Math.hypot(p.x - cx, p.y - cy) - r) < 0.5)); // a true circle
  const rect = recognize(box);
  assert.equal(rect.length, 5);
  assert.ok(rect[0].y === rect[1].y && rect[1].x === rect[2].x && rect[2].y === rect[3].y && rect[3].x === rect[0].x); // square corners
  assert.equal(recognize([jit(10, 10), jit(100, 45), jit(200, 80), jit(300, 118)]).length, 2);
  assert.equal(recognize(Array.from({ length: 50 }, (_, i) => jit(100 + i * 4, 200 + 60 * Math.sin(i / 8), 2))), null);

  const drawing = require('../src/main/plugins/builtin/drawing');
  const ctx = drawCtx();
  assert.equal(await drawing.run({ action: 'tidy' }, ctx), 'Tidied 2 shapes.');
  assert.deepEqual(ctx.ops[0], { op: 'tidy', rect: null });
});
