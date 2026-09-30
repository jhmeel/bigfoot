'use strict';
// Live check on a real desktop: opens Notepad, types, copies, verifies, then closes it without saving.
// Run manually with: node test/live-input.js  (moves focus to Notepad for a few seconds)

require('./electron-stub');
const { execFileSync } = require('child_process');
const path = require('path');
const { InputHelper } = require('../src/main/input');
const apps = require('../src/main/plugins/builtin/apps');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`], { encoding: 'utf8' }).trim();

async function main() {
  const input = new InputHelper(path.join(__dirname, '..', 'src', 'main', 'native', 'input-helper.exe'));
  await input.start();
  const clipboardBefore = ps('Get-Clipboard -Raw');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

  try {
    const openApp = apps.find((t) => t.name === 'open_app');
    const msg = await openApp.run({ name: 'notepad' }, { confirm: async () => {}, sleep });
    check('open_app finds and launches Notepad', /Notepad/i.test(msg), msg);
    await sleep(2500);

    const title = await input.windowTitle();
    check('Notepad is the focused window', /notepad/i.test(title), title);
    if (!/notepad/i.test(title)) throw new Error('Notepad did not get focus; stopping before typing anything.');

    const text = 'Bigfoot typed this: héllo wörld ✓ 123';
    await input.type(text);
    await sleep(300);
    await input.keys('ctrl+a');
    await input.keys('ctrl+c');
    await sleep(400);
    const copied = ps('Get-Clipboard -Raw');
    check('typing (including accents and symbols) and copying', copied === text, JSON.stringify(copied));

    const pos = await input.cursor();
    await input.move(pos.x + 40, pos.y + 25);
    const moved = await input.cursor();
    check('mouse moves to exact coordinates', moved.x === pos.x + 40 && moved.y === pos.y + 25, `${JSON.stringify(pos)} -> ${JSON.stringify(moved)}`);
    await input.move(pos.x, pos.y);
  } finally {
    try { ps("Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force"); } catch { /* already closed */ }
    try { ps(`Set-Clipboard -Value ${JSON.stringify(clipboardBefore || ' ')}`); } catch { /* best effort */ }
    input.stop();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} check(s) failed` : 'all live checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('live test error:', err.message); process.exit(1); });
