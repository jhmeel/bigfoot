'use strict';

require('./electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const catalog = require('../src/main/local/catalog');
const { downloadFile, sha256File, DownloadError } = require('../src/main/local/download');
const { LocalModelManager } = require('../src/main/local/manager');
const { adaptersFromReg } = require('../src/main/local/hardware');
const { LocalProvider, GRID } = require('../src/main/llm/local');
const { evaluate } = require('../src/main/math');
const { parseReply, resolveAnswer } = require('../src/main/mathink');
const { costOf } = require('../src/main/costs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bigfoot-local-'));

// recommendation
test('the recommended model matches the hardware', () => {
  const rtx4060 = catalog.recommend({ ramGB: 16, vramGB: 8, dedicated: true, freeDiskGB: 200 });
  assert.equal(rtx4060.pick, 'qwen3-vl-8b');
  assert.equal(rtx4060.options.find((o) => o.id === 'qwen3-vl-4b').note, 'Faster / lighter');
  assert.equal(rtx4060.options.find((o) => o.id === 'qwen3-vl-30b').available, false);
  assert.equal(rtx4060.options.find((o) => o.id === 'qwen3-vl-30b').note, 'Requires more memory');

  const laptop = catalog.recommend({ ramGB: 7.9, vramGB: 0, dedicated: false, freeDiskGB: 174 });
  assert.equal(laptop.pick, 'qwen3-vl-4b');
  assert.equal(laptop.options.find((o) => o.id === 'qwen3-vl-8b').available, false);
  assert.equal(laptop.options.find((o) => o.id === 'qwen3-vl-4b').available, true);

  assert.equal(catalog.recommend({ ramGB: 64, vramGB: 24, dedicated: true }).pick, 'qwen3-vl-30b');
  assert.equal(catalog.recommend({ ramGB: 32, vramGB: 0, dedicated: false }).pick, 'qwen3-vl-4b');

  const noDisk = catalog.recommend({ ramGB: 16, vramGB: 8, dedicated: true, freeDiskGB: 3 });
  assert.equal(noDisk.options.find((o) => o.id === 'qwen3-vl-8b').available, false);
  assert.equal(noDisk.options.find((o) => o.id === 'qwen3-vl-8b').note, 'Not enough disk space');
});

test('every download is pinned and verifiable', () => {
  for (const m of catalog.MODELS) {
    for (const f of catalog.filesFor(m.id)) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(f.size > 1e6);
      assert.match(f.url, /^https:\/\/(huggingface\.co\/Qwen\/[\w.-]+\/resolve\/[0-9a-f]{40}\/|github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b\d+\/)/);
    }
  }
});

test('GPU memory is read from the display adapter registry', () => {
  const reg = [
    'HKEY_LOCAL_MACHINE\\SYSTEM\\X\\0000',
    '    DriverDesc    REG_SZ    NVIDIA GeForce RTX 4060',
    '    MatchingDeviceId    REG_SZ    pci\\ven_10de&dev_2882',
    '    HardwareInformation.qwMemorySize    REG_QWORD    0x200000000',
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\X\\0001',
    '    DriverDesc    REG_SZ    Microsoft Basic Display Adapter',
  ].join('\r\n');
  const [gpu, ...rest] = adaptersFromReg(reg);
  assert.equal(gpu.name, 'NVIDIA GeForce RTX 4060');
  assert.equal(gpu.vramGB, 8);
  assert.equal(gpu.vendor, '10de');
  assert.equal(rest.length, 0);
});

// resumable download
function fileServer(data, { dropAfter = null, ignoreRange = false } = {}) {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (req.url === '/missing') { res.writeHead(404); res.end(); return; }
    const start = m && !ignoreRange ? Number(m[1]) : 0;
    const body = data.subarray(start);
    res.writeHead(start ? 206 : 200, {
      'Content-Length': body.length,
      ...(start ? { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } : {}),
    });
    if (dropAfter != null && requests === 1) {
      res.write(body.subarray(0, dropAfter), () => res.socket.destroy());
      return;
    }
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, close: () => server.close(), requests: () => requests,
  })));
}

test('a dropped download resumes from the bytes already on disk', async () => {
  const data = crypto.randomBytes(600 * 1024);
  const srv = await fileServer(data, { dropAfter: 200 * 1024 });
  const dest = path.join(tmp(), 'file.part');
  try {
    await assert.rejects(downloadFile({ url: `${srv.url}/f`, dest, size: data.length }), (e) => e instanceof DownloadError && e.retryable);
    const partial = fs.statSync(dest).size;
    assert.ok(partial > 0 && partial < data.length);
    let resumedBytes = 0;
    await downloadFile({ url: `${srv.url}/f`, dest, size: data.length, onBytes: (n) => { resumedBytes += n; } });
    assert.equal(resumedBytes, data.length - partial); // only the rest was fetched
    assert.ok(fs.readFileSync(dest).equals(data));
    assert.equal(await sha256File(dest), crypto.createHash('sha256').update(data).digest('hex'));
  } finally {
    srv.close();
  }
});

test('a server that ignores Range restarts the file cleanly, and 404 is not retried', async () => {
  const data = crypto.randomBytes(64 * 1024);
  const srv = await fileServer(data, { ignoreRange: true });
  const dest = path.join(tmp(), 'file.part');
  try {
    fs.writeFileSync(dest, data.subarray(0, 1000));
    await downloadFile({ url: `${srv.url}/f`, dest, size: data.length });
    assert.ok(fs.readFileSync(dest).equals(data));
    await assert.rejects(downloadFile({ url: `${srv.url}/missing`, dest: `${dest}2`, size: 10 }), (e) => e.retryable === false && e.status === 404);
  } finally {
    srv.close();
  }
});

test('a corrupted download is fetched again, then fails with a clear message and can be retried', async () => {
  const dir = tmp();
  const values = { localModel: '' };
  const settings = { get: (k) => values[k], update: (p) => Object.assign(values, p) };
  let calls = 0;
  const fetchImpl = async (_url, { headers }) => {
    calls++;
    const size = catalog.runtimeFor('x64').size;
    const start = headers.Range ? Number(/\d+/.exec(headers.Range)[0]) : 0;
    return new Response(new Uint8Array(size - start), { status: start ? 206 : 200, headers: start ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {} });
  };
  const m = new LocalModelManager({ dir, settings, fetchImpl, arch: 'x64' });
  const failed = new Promise((resolve) => m.on('progress', (s) => { if (s.status === 'failed') resolve(s); }));
  m.start('qwen3-vl-4b');
  const s = await failed;
  assert.equal(calls, 2); // one automatic re-download after the first checksum mismatch
  assert.match(s.message, /corrupted twice/);
  assert.equal(values.localModel, '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).status, 'failed');

  const again = new Promise((resolve) => m.on('progress', (x) => { if (x.status === 'downloading') resolve(); }));
  m.resume();
  await again;
  await m.cancel();
  assert.equal(m.snapshot().status, 'none');
  assert.ok(!fs.existsSync(path.join(dir, 'state.json')));
});

test('pausing keeps the partial file and resuming continues it', async () => {
  const dir = tmp();
  const settings = { get: () => '', update() {} };
  const fetchImpl = async (_url, { signal }) => new Response(new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new Uint8Array(4096));
      signal.addEventListener('abort', () => ctrl.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    },
  }), { status: 200 });
  const m = new LocalModelManager({ dir, settings, fetchImpl, arch: 'x64' });
  const downloading = new Promise((resolve) => m.on('progress', (s) => { if (s.status === 'downloading' && s.bytesDone > 0) resolve(); }));
  m.start('qwen3-vl-4b');
  await downloading;
  assert.equal(m.pause().status, 'paused');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).pausedBy, 'user');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.statSync(path.join(dir, 'runtime', `${catalog.runtimeFor('x64').name}.part`)).size, 4096);
  const reloaded = new LocalModelManager({ dir, settings, fetchImpl, arch: 'x64' });
  assert.equal(reloaded.snapshot().status, 'paused'); // a user pause survives a restart
  await m.cancel();
});

// local provider
test('the local model points on a 1000 grid that maps onto the screenshot', () => {
  const p = new LocalProvider({ runtime: {}, model: 'qwen3-vl-8b', system: 'sys', tools: [], screen: { width: 1280, height: 720 } });
  assert.match(p.messages[0].content, /1000x1000 grid/);
  assert.match(p.tools[0].function.description, new RegExp(`${GRID}x${GRID} grid`));
  const click = p.convertCall({ id: '1', name: 'left_click', computer: true, input: { coordinate: [500, 500] } });
  assert.deepEqual(click.input.coordinate, [640, 360]);
  const drag = p.convertCall({ id: '2', name: 'left_click_drag', computer: true, input: { start_coordinate: [0, 0], coordinate: [1000, 1000] } });
  assert.deepEqual([drag.input.start_coordinate, drag.input.coordinate], [[0, 0], [1280, 720]]);
  const zoom = p.convertCall({ id: '3', name: 'zoom', computer: true, input: { region: [250, 250, 750, 750] } });
  assert.deepEqual(zoom.input.region, [320, 180, 960, 540]);
  const draw = p.convertCall({ id: '4', name: 'annotate', computer: false, input: { shape: 'box', points: [[100, 100], [200, 200]] } });
  assert.deepEqual(draw.input.points, [[128, 72], [256, 144]]);
  assert.equal(p.convertText('here [POINT:500,250:save]'), 'here [POINT:640,180:save]');
  assert.deepEqual(p.fromScreen([640, 360, 1280, 720]), [500, 500, 1000, 1000]);
  p.addToolResults([{ call: { id: '5', name: 'cursor_position', computer: true }, content: 'X=640, Y=360' }]);
  assert.equal(p.messages[p.messages.length - 1].content, 'X=500, Y=500');
});

test('the AI edits the user\'s drawing in screen coordinates', async () => {
  const tool = require('../src/main/plugins/builtin/drawing');
  const sent = [];
  const ctx = {
    screen: { sentToLocalDip: ([x, y]) => ({ x: x / 2, y: y / 2 }) },
    ink: async (op) => { sent.push(op); return op.op === 'erase' ? 2 : 1; },
  };
  assert.match(await tool.run({ action: 'add', shape: 'ellipse', points: [[100, 100], [300, 200], [500, 400]], color: 'blue', width: 'thick' }, ctx), /^Added an ellipse/);
  assert.deepEqual(sent[0].stroke, { tool: 'ellipse', color: '#0a84ff', size: 2, points: [{ x: 50, y: 50 }, { x: 250, y: 200 }], text: undefined });
  await tool.run({ action: 'add', shape: 'path', pen: 'highlighter', points: [[0, 0], [10, 10], [20, 0]] }, ctx);
  assert.equal(sent[1].stroke.tool, 'highlighter');
  assert.equal(sent[1].stroke.points.length, 3);
  assert.equal(await tool.run({ action: 'erase', region: [200, 200, 0, 0] }, ctx), 'Erased 2 strokes.');
  assert.deepEqual(sent[2].rect, { x0: 0, y0: 0, x1: 100, y1: 100 });
  await assert.rejects(tool.run({ action: 'add', shape: 'text', points: [[1, 1]] }, ctx), /needs text/);
  await assert.rejects(tool.run({ action: 'erase' }, ctx), /region/);

  const p = new LocalProvider({ runtime: {}, model: 'qwen3-vl-8b', system: 's', tools: [], screen: { width: 1000, height: 500 } });
  const call = p.convertCall({ id: '1', name: 'edit_drawing', computer: false, input: { action: 'erase', region: [100, 100, 500, 500], points: [[1000, 1000]] } });
  assert.deepEqual(call.input.region, [100, 50, 500, 250]);
  assert.deepEqual(call.input.points, [[1000, 500]]);
});

test('a streamed answer is rebuilt exactly, text and tool calls, while the text is shown live', async () => {
  const { readStream } = require('../src/main/llm/local');
  const events = [
    { model: 'qwen3-vl-4b', choices: [{ delta: { content: 'Opening ' } }] },
    { choices: [{ delta: { content: 'Notepad.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'open_', arguments: '{"na' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'app', arguments: 'me":"Notepad"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 900, completion_tokens: 12 } },
  ];
  const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(sse);
  const res = new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 37) c.enqueue(bytes.slice(i, i + 37)); c.close(); } }));
  const seen = [];
  const body = await readStream(res, (t) => seen.push(t));
  assert.deepEqual(seen, ['Opening ', 'Opening Notepad.']);
  assert.equal(body.model, 'qwen3-vl-4b');
  assert.deepEqual(body.usage, { prompt_tokens: 900, completion_tokens: 12 });
  const msg = body.choices[0].message;
  assert.equal(msg.content, 'Opening Notepad.');
  assert.deepEqual(msg.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'open_app', arguments: '{"name":"Notepad"}' } }]);
});

test('Windows Math Recognizer MathML becomes math the solvers read: powers, fractions, roots, calculus', () => {
  const { mathmlToText } = require('../src/main/mathml');
  const { interpretInk } = require('../src/main/mathink');
  const m = (body) => `<m:math xmlns:m="http://www.w3.org/1998/Math/MathML">${body}</m:math>`;
  assert.equal(mathmlToText(m('<m:mn>2</m:mn><m:mi>x</m:mi><m:mo>+</m:mo><m:mn>1</m:mn><m:mo>=</m:mo><m:mn>7</m:mn>')), '2x+1=7');
  assert.equal(mathmlToText(m('<m:msup><m:mrow><m:mi>x</m:mi></m:mrow><m:mrow><m:mn>2</m:mn></m:mrow></m:msup><m:mo>-</m:mo><m:mn>5</m:mn><m:mi>x</m:mi><m:mo>+</m:mo><m:mn>6</m:mn><m:mo>=</m:mo><m:mn>0</m:mn>')), 'x^(2)-5x+6=0');
  assert.equal(mathmlToText(m('<m:mfrac><m:mrow><m:mi>x</m:mi><m:mo>+</m:mo><m:mn>1</m:mn></m:mrow><m:mn>2</m:mn></m:mfrac><m:mo>=</m:mo><m:mn>4</m:mn>')), '(x+1)/2=4');
  assert.equal(mathmlToText(m('<m:msqrt><m:mn>9</m:mn></m:msqrt><m:mo>+</m:mo><m:mn>4</m:mn>')), 'sqrt(9)+4');
  assert.equal(mathmlToText(m('<m:mn>12</m:mn><m:mo>&#xD7;</m:mo><m:mn>4</m:mn>')), '12*4'); // × is times, never the letter x
  assert.equal(mathmlToText(m('<m:mfrac><m:mi>d</m:mi><m:mrow><m:mi>d</m:mi><m:mi>x</m:mi></m:mrow></m:mfrac><m:msup><m:mi>x</m:mi><m:mn>3</m:mn></m:msup>')), 'd/dx x^(3)');
  assert.equal(mathmlToText(m('<m:msubsup><m:mo>&#x222B;</m:mo><m:mn>0</m:mn><m:mn>3</m:mn></m:msubsup><m:msup><m:mi>x</m:mi><m:mn>2</m:mn></m:msup><m:mi>d</m:mi><m:mi>x</m:mi>')), '∫(0,3)x^(2)dx');
  assert.equal(mathmlToText(''), '');
  // …and on to the answers
  assert.equal(interpretInk([['x^(2)-5x+6=0']]).answer, 'x = 2, 3');
  assert.equal(interpretInk([['(x+1)/2=4']]).answer, 'x = 7');
  assert.equal(require('../src/main/cas').fromHandwriting('d/dx x^(3)'), 'diff(x^(3),x)');
});

test('a new request keeps earlier turns as text only, so it never re-reads old screenshots', () => {
  const p = new LocalProvider({ runtime: {}, model: 'm', system: 'SYS', tools: [], screen: { width: 1000, height: 500 } });
  const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  p.messages.push(
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: 'Hi there!' },
    { role: 'user', content: [{ type: 'text', text: 'open chrome and search hospital' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'open_app', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'Opened' },
    { role: 'user', content: [img, { type: 'text', text: 'Screen after those actions' }] },
    { role: 'user', content: [{ type: 'text', text: 'find and download a song' }] }, // stopped, never answered
  );
  const system = p.messages[0];
  p.startTask();
  assert.equal(p.messages[0], system); // the saved instructions stay valid
  assert.deepEqual(p.messages.slice(1), [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hi there!' }]);
});

test('requests to the local model wait as long as it makes progress, and stop when it stalls', async () => {
  const http = require('http');
  const { localPost } = require('../src/main/llm/localhttp');
  const { readStream } = require('../src/main/llm/local');
  // A slow model: reading progress every 150 ms for 0.9 s (longer than the 400 ms stall limit), then the answer.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/hang') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); return; } // starts, then says nothing
      if (req.url === '/queued') { setTimeout(() => { res.writeHead(200); res.end('{"ok":true}'); }, 900); return; }
      assert.equal(JSON.parse(body).return_progress, true);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let n = 0;
      const tick = setInterval(() => {
        n += 1;
        res.write(`data: ${JSON.stringify({ prompt_progress: { total: 6, cache: 0, processed: n, time_ms: n * 150 } })}\n\n`);
        if (n === 6) {
          clearInterval(tick);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi!' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
          res.end();
        }
      }, 150);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const progress = [];
    const res = await localPost(`${url}/v1/chat/completions`, { key: 'k', body: { return_progress: true }, stallMs: 400 });
    const out = await readStream(res, () => {}, (p) => progress.push(p.processed));
    assert.equal(out.choices[0].message.content, 'Hi!');
    assert.deepEqual(progress, [1, 2, 3, 4, 5, 6]); // shown as a progress bar, never mistaken for text

    // Silent before or after the reply starts: either way it's reported as a stall.
    await assert.rejects(localPost(`${url}/hang`, { body: {}, stallMs: 300 }).then((r) => readStream(r, () => {})), (err) => err.stalled === true);

    // Queued behind the one-time preparation: silence is expected, so it isn't a stall.
    const queued = await localPost(`${url}/queued`, { body: {}, stallMs: 300, waiting: () => true });
    assert.deepEqual(await queued.json(), { ok: true });
  } finally {
    server.close();
  }
});

test('old screenshots are dropped in batches so the cached context survives', () => {
  const p = new LocalProvider({ runtime: {}, model: 'm', system: 's', tools: [], screen: { width: 100, height: 100 } });
  const shot = () => p.messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] });
  const images = () => p.messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'image_url').length : 0), 0);
  for (let i = 0; i < 4; i++) shot();
  const before = JSON.stringify(p.messages);
  p.trimImages();
  assert.equal(JSON.stringify(p.messages), before); // up to 4: history untouched, cache intact
  shot();
  p.trimImages();
  assert.equal(images(), 2);
});

test('smaller machines get smaller screenshots, and a kept-loaded model never unloads', () => {
  const { tuningFor, LocalRuntime } = require('../src/main/local/runtime');
  assert.deepEqual(tuningFor({ dedicated: false, vramGB: 0, ramGB: 8 }), { imageTokens: 256, edge: 1024, cpuOnly: true, lock: false });
  assert.deepEqual(tuningFor({ dedicated: true, vramGB: 4, ramGB: 16 }), { imageTokens: 768, edge: 1280, cpuOnly: false, lock: true });
  assert.deepEqual(tuningFor({ dedicated: true, vramGB: 8, ramGB: 8 }), { imageTokens: 1024, edge: 1280, cpuOnly: false, lock: false });
  const manager = { on() {}, paths: () => null };
  const kept = new LocalRuntime({ manager, settings: { get: () => true } });
  kept.touch();
  assert.equal(kept.idleTimer, null);
  const idle = new LocalRuntime({ manager, settings: { get: () => false } });
  idle.touch();
  assert.ok(idle.idleTimer);
  clearTimeout(idle.idleTimer);
});

test('handwriting is read live: answered after "=", checked when the user wrote an answer', () => {
  const { interpretInk } = require('../src/main/mathink');
  assert.deepEqual(interpretInk([['1+1', '+1', '1+7'], ['=', '=.', '-']]), { text: '1 + 1 =', status: 'answer', answer: '2', expression: '1+1' });
  assert.equal(interpretInk([['l2 x 4 =']]).answer, '48'); // "l" is a 1, "x" between numbers is times
  assert.equal(interpretInk([['12+7=20']]).status, 'wrong');
  assert.equal(interpretInk([['12+7=20']]).answer, '19');
  assert.equal(interpretInk([['12+7=19']]).status, 'right');
  assert.equal(interpretInk([['9÷3']]).status, 'writing'); // no "=" yet: show the reading only
  assert.equal(interpretInk([['2x+1=7']]).answer, 'x = 3'); // solved here, no model needed
  assert.equal(interpretInk([['2b+1=7']]).answer, 'b = 3'); // a b is a variable, not a 6
  assert.equal(interpretInk([['x^2-5x+6=0']]).answer, 'x = 2, 3');
  assert.equal(interpretInk([['3x+2=2x+5']]).answer, 'x = 3'); // "=" inside an equation isn't an answer
  assert.equal(interpretInk([['x+y=2']]).answer, 'y = 2 − x'); // two unknowns: solved for one
  assert.equal(interpretInk([['xy=6']]).status, 'solve'); // not linear: the model reads it
  // The recognizer's best reading decides letters vs digits: "2x" never becomes "24", "y" never "2".
  assert.equal(interpretInk([['2x', '24']]).text, '2x');
  assert.equal(interpretInk([['y', '2']]).text, 'y');
  assert.equal(interpretInk([['2x+1=7', '24+1=7']]).answer, 'x = 3');
  assert.equal(interpretInk([['24', '2x']]).answer, '24');
  assert.equal(interpretInk([['hello']]).status, 'unknown');
});

test('speech: Whisper noise markers are not words', () => {
  const { cleanTranscript } = require('../src/main/local/speech');
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('Open Notepad. (keyboard clicking) Thanks'), 'Open Notepad. Thanks');
});

test('apps that are not installed open their web version', () => {
  const { WEB_APPS } = require('../src/main/plugins/builtin/apps');
  assert.equal(WEB_APPS.spotify, 'https://open.spotify.com');
  assert.ok(Object.values(WEB_APPS).every((u) => /^https:\/\//.test(u)));
});

test('local runs are free', () => {
  assert.equal(costOf('qwen3-vl-8b', { input_tokens: 5_000_000, output_tokens: 1_000_000 }).cost, 0);
});

// math tool
test('handwritten arithmetic is evaluated exactly', () => {
  const cases = {
    '12 + 7 =': '19', '3 x 4': '12', '2(3+4)': '14', '-2^2': '-4', '2^3^2': '512', '10 ÷ 4': '2.5',
    '√16 + 1': '5', '5!': '120', '50% * 80': '40', '0.1+0.2': '0.3', '2pi': '6.28318530718', 'sin 30': '0.5',
    '1,000 * 3': '3000', '\\frac{1}{4}+\\frac{1}{4}': '0.5', '12 − 5 =': '7', '|3-10|': '7', '(2+3)*(4-1)^2': '45',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(evaluate(input).text, want, input);
  assert.throws(() => evaluate('7 / 0'), /divide by zero/);
  assert.throws(() => evaluate('3x + 2'), /variable/);
  assert.throws(() => evaluate('3x + 2 = 8'), /equation/);
  assert.throws(() => evaluate('process.exit()'));
});

test('the model reads, the calculator answers (never the model’s own arithmetic)', async () => {
  assert.deepEqual(parseReply('```json\n{"expression": "12+7", "answer": "20"}\n```'), { expression: '12+7', compute: '' });
  assert.deepEqual(parseReply('no idea'), { expression: '', compute: '' });
  assert.equal((await resolveAnswer({ expression: '12+7' })).answer, '19');
  const eq = await resolveAnswer({ expression: '3x + 2 = 8' });
  assert.equal(eq.answer, 'x = 2');
  assert.ok(eq.steps.length >= 3); // the working is shown
  const sys = await resolveAnswer({ expression: 'x+y=5 and x-y=1', compute: 'system(x+y=5; x-y=1)' });
  assert.equal(sys.answer, 'x = 3, y = 2');
  assert.equal((await resolveAnswer({ expression: '', compute: '' })).answer, '');
});

test('calculus and vectors are computed exactly, with their working', async () => {
  const cas = require('../src/main/cas');
  assert.equal((await cas.compute('diff(x^3+2*x, x)')).answer, '2+3x²');
  assert.equal((await cas.compute('defint(x^2, 0, 3, x)')).answer, '9');
  assert.equal((await cas.compute('defint(sin(x), 0, pi, x)')).answer, '2');
  assert.equal((await cas.compute('cross([1,2,3],[4,5,6])')).answer, '[-3,6,-3]');
  assert.equal((await cas.compute('dot([1,2,3],[4,5,6])')).answer, '32');
  assert.equal((await cas.compute('limit(sin(x)/x, x, 0)')).answer, '1');
  assert.equal(cas.fromHandwriting('∫x^2dx'), 'integrate(x^2,x)');
  assert.equal(cas.fromHandwriting('d/dx x^3'), 'diff(x^3,x)');
  assert.equal(cas.fromHandwriting('2x+1'), null);
  const steps = await cas.working('defint(x^2,0,3,x)');
  assert.deepEqual(steps.slice(-1), ['F(3) − F(0) = 9']);
  await assert.rejects(cas.compute('process.exit()'), /isn’t math/);
});

test('equations: several unknowns, systems, powers, and the working', () => {
  const { solveEquation, solveSystem } = require('../src/main/math');
  const { splitScripts } = require('../src/main/mathink');
  assert.equal(solveEquation('2x+2y=6').text, 'y = 3 − x');
  assert.equal(solveEquation('x^2-5x+6=0').text, 'x = 2, 3');
  assert.equal(solveSystem(['x+y=5', 'x-y=1']).text, 'x = 3, y = 2');
  assert.throws(() => solveSystem(['x+y=2', '2x+2y=4']), /single answer/);
  assert.ok(solveEquation('x^2-5x+6=0').steps.some((s) => s.startsWith('Discriminant')));
  const line = (x0, y0, x1, y1) => Array.from({ length: 8 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 7, y: y0 + ((y1 - y0) * i) / 7 }));
  const runs = splitScripts([line(100, 100, 130, 140), line(130, 100, 100, 140), line(140, 82, 152, 98), line(170, 120, 190, 120)]);
  assert.deepEqual(runs.map((r) => r.sup), [false, true, false]); // x, a raised 2, then the rest
});

test('2B is no longer offered, and an installed 2B is replaced by the recommended model', async () => {
  assert.ok(!catalog.MODELS.some((m) => m.id === 'qwen3-vl-2b'));
  assert.equal(catalog.recommend({ ramGB: 4, vramGB: 0, dedicated: false }).pick, 'qwen3-vl-4b'); // 4B is the floor

  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'models', 'qwen3-vl-2b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'models', 'qwen3-vl-2b', 'old.gguf'), 'x');
  const values = { localModel: 'qwen3-vl-2b' };
  const settings = { get: (k) => values[k], update: (p) => Object.assign(values, p) };
  const fetchImpl = async (_url, { signal }) => new Response(new ReadableStream({
    start(ctrl) { signal.addEventListener('abort', () => ctrl.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))); },
  }), { status: 200 });
  const m = new LocalModelManager({ dir, settings, fetchImpl, arch: 'x64' });
  const started = await m.replaceRetired(async () => ({ pick: 'qwen3-vl-4b' }));
  assert.equal(started, 'qwen3-vl-4b');
  assert.equal(values.localModel, '');
  assert.ok(!fs.existsSync(path.join(dir, 'models', 'qwen3-vl-2b')));
  assert.equal(m.snapshot().modelId, 'qwen3-vl-4b');
  await m.cancel();
  assert.equal(await m.replaceRetired(async () => ({ pick: 'qwen3-vl-4b' })), null); // only once
});

test('old screen lists are dropped in batches, keeping the latest two', () => {
  const { LocalProvider } = require('../src/main/llm/local');
  const p = new LocalProvider({ runtime: {}, model: 'm', system: 's', tools: [], screen: { width: 1000, height: 1000 } });
  for (let i = 0; i < 5; i++) p.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `Clicked ${i}.\nOn screen: "w" (app).\n[1] button "b${i}" @1,1` });
  p.trimLists();
  const contents = p.messages.slice(1).map((m) => m.content);
  assert.equal(contents.filter((c) => /older screen list removed/.test(c)).length, 3);
  assert.match(contents[0], /^Clicked 0\.\n\(older screen list removed\)$/);
  assert.match(contents[4], /\[1\] button "b4"/);
  p.trimLists(); // with two left there's nothing more to drop
  assert.equal(p.messages.slice(1).filter((m) => /On screen:/.test(m.content)).length, 2);
});

test('the saved instructions are always the instructions, even when a math reading arrives mid-way', async () => {
  const { LocalRuntime } = require('../src/main/local/runtime');
  const { askLocal } = require('../src/main/llm/local');
  // A one-slot model server: it reuses the longest common start of what it holds, like llama.cpp.
  let slot = '';
  const files = {};
  const log = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      if (req.url.startsWith('/slots/0')) {
        const action = /action=(\w+)/.exec(req.url)[1];
        log.push(`${action}:${b.filename}`);
        if (action === 'save') files[b.filename] = slot;
        else if (files[b.filename] == null) { res.writeHead(404); res.end('{}'); return; } else slot = files[b.filename];
        res.writeHead(200); res.end('{}');
        return;
      }
      const prompt = JSON.stringify([b.tools || [], b.messages]).replace(/]]$/, ''); // tools come first, as in the real template
      let same = 0;
      while (same < slot.length && same < prompt.length && slot[same] === prompt[same]) same++;
      const timings = { cache_n: same, prompt_n: prompt.length - same };
      log.push(`ask:${b.messages[b.messages.length - 1].content.length ? 'text' : ''}:${timings.prompt_n}`);
      setTimeout(() => {
        slot = prompt;
        if (!b.stream) { res.writeHead(200); res.end(JSON.stringify({ timings, choices: [{ message: { content: '{"expression":"1+1"}' } }] })); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'I’m Bigfoot.' }, finish_reason: 'stop' }], timings })}\n\ndata: [DONE]\n\n`);
      }, 150);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', model: 'qwen' };
  const runtime = { endpoint, busy: 0, slotHolds: null, ensure: async () => endpoint, touch() {}, pruneCache() {}, preparing: null };
  for (const k of ['exclusive', 'use', 'slot']) runtime[k] = LocalRuntime.prototype[k];
  const tools = [{ name: 'read_screen', description: 'Read the screen as a list.', input_schema: { type: 'object', properties: {} } }];
  const newProvider = () => new LocalProvider({ runtime, model: 'qwen', system: 'You are Bigfoot. '.repeat(400), tools, screen: { width: 1000, height: 1000 } });
  try {
    const p = newProvider();
    p.onText = () => {};
    // A math reading arrives while the instructions are being read.
    const warming = p.warm();
    const math = askLocal(runtime, { prompt: 'Read this math', image: 'aGk=' });
    await Promise.all([warming, math]);
    const file = p.prefixFile();
    assert.match(files[file], /You are Bigfoot/); // the instructions were saved, not the math reading
    assert.doesNotMatch(files[file], /Read this math/);

    // The next question puts the instructions back and reads only itself.
    p.startTask();
    p.addUserMessage('What is your name?');
    await p.step();
    const last = log.filter((l) => l.startsWith('ask:')).pop();
    assert.ok(Number(last.split(':')[2]) < 200, `read ${last}`);

    // A wrong saved copy (an older version's) is noticed and replaced the first time it's used.
    files[file] = 'something else entirely';
    runtime.slotHolds = null;
    const q = newProvider();
    q.onText = () => {};
    assert.equal(await q.warm(), false); // it had to read them
    assert.match(files[file], /You are Bigfoot/);
    assert.equal(await newProvider().warm(), true); // and from then on they're restored
  } finally {
    server.close();
  }
});

test('a model already on disk is found and used, so setup never downloads it again', () => {
  const dir = tmp();
  const values = { localModel: '' };
  const settings = { get: (k) => values[k], update: (p) => Object.assign(values, p) };
  const fake = { id: 'test-vl', label: 'Test VL', files: [{ name: 'm.gguf', size: 5 }, { name: 'mm.gguf', size: 3 }] };
  catalog.MODELS.push(fake);
  try {
    const m = new LocalModelManager({ dir, settings });
    assert.equal(m.installedId(), ''); // nothing there yet
    fs.mkdirSync(m.runtimeDir(), { recursive: true });
    fs.writeFileSync(path.join(m.runtimeDir(), 'llama-server.exe'), 'x');
    fs.mkdirSync(m.modelDir('test-vl'), { recursive: true });
    fs.writeFileSync(path.join(m.modelDir('test-vl'), 'm.gguf'), '12345');
    fs.writeFileSync(path.join(m.modelDir('test-vl'), 'mm.gguf'), '12'); // one byte short: not complete
    assert.equal(m.installedId(), '');
    fs.writeFileSync(path.join(m.modelDir('test-vl'), 'mm.gguf'), '123');
    assert.equal(m.installedId(), 'test-vl'); // found by its files, though settings were empty
    assert.equal(values.localModel, 'test-vl');
    assert.equal(m.snapshot().status, 'ready');
  } finally {
    catalog.MODELS.splice(catalog.MODELS.indexOf(fake), 1);
  }
});
