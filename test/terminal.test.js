'use strict';
// Real terminals (src/main/terminals.js): a PowerShell in a pseudo-console, driven like the AI does.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { Terminals } = require('../src/main/terminals');

test('commands run in a real PowerShell: output, exit codes, errors, and the folder carries over', { skip: process.platform !== 'win32' }, async () => {
  const t = new Terminals();
  const { id } = t.create({ shell: 'powershell', owner: 'ai' });
  try {
    await t.ready(id);
    let r = await t.run(id, '"one"; "two"', { timeoutMs: 30000 });
    assert.deepEqual([r.done, r.exitCode, r.output.replace(/\r/g, '')], [true, 0, 'one\ntwo']);
    r = await t.run(id, 'cmd /c exit 3', { timeoutMs: 30000 });
    assert.equal(r.exitCode, 3);
    r = await t.run(id, '"fine"', { timeoutMs: 30000 });
    assert.equal(r.exitCode, 0); // the last exit code doesn't leak into the next command
    r = await t.run(id, 'Get-Item no-such-file-here', { timeoutMs: 30000 });
    assert.equal(r.exitCode, 1);
    assert.match(r.output, /Cannot find path/);
    r = await t.run(id, 'if (', { timeoutMs: 30000 }); // a syntax error still reports back
    assert.equal(r.done, true);
    assert.equal(r.exitCode, 1);
    r = await t.run(id, '(Get-Location).Path', { cwd: os.tmpdir(), timeoutMs: 30000 });
    assert.equal(r.output, os.tmpdir());
    r = await t.run(id, '(Get-Location).Path', { timeoutMs: 30000 });
    assert.equal(r.output, os.tmpdir()); // still there, like a person's terminal
    r = await t.run(id, 'Start-Sleep 3', { timeoutMs: 800 });
    assert.equal(r.done, false); // reported as still running, not as finished
  } finally {
    t.closeAll();
  }
});

test('a server\'s localhost address is picked up from its output', { skip: process.platform !== 'win32' }, async () => {
  const t = new Terminals();
  const urls = [];
  t.on('url', ({ url }) => urls.push(url));
  const { id } = t.create({ shell: 'powershell' });
  try {
    await t.ready(id);
    t.write(id, 'Write-Host "  ➜  Local:   http://localhost:5173/"; Write-Host "Listening on http://0.0.0.0:8000."\r');
    for (let i = 0; i < 60 && urls.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(urls, ['http://localhost:5173/', 'http://localhost:8000']);
    assert.deepEqual(t.list()[0].urls, urls);
  } finally {
    t.closeAll();
  }
});
