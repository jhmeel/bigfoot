'use strict';
// Visual QA: set BIGFOOT_DEMO=1 to play every overlay effect once, on the display under the cursor.

const { screen } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runDemo({ windows, controller }) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const win = windows.overlayFor(display.id);
  const { width: W, height: H } = display.bounds;
  const send = (channel, payload) => windows.send(win, channel, payload);
  const at = (fx, fy) => ({ x: W * fx, y: H * fy });

  await wait(2500);
  send('annotate', { shape: 'box', points: [at(0.1, 0.15), at(0.32, 0.3)], label: 'Highlighted component', color: 'blue', duration: 14 });
  await wait(500);
  send('annotate', { shape: 'spotlight', points: [at(0.55, 0.12), at(0.85, 0.32)], label: 'Spotlight', color: 'yellow', duration: 14 });
  await wait(500);
  send('annotate', { shape: 'circle', points: [at(0.12, 0.45), at(0.26, 0.6)], label: 'Circled', color: 'green', duration: 14 });
  await wait(500);
  send('annotate', { shape: 'arrow', points: [at(0.45, 0.7), at(0.3, 0.55)], label: 'Look here', color: 'red', duration: 14 });
  await wait(500);
  const wave = Array.from({ length: 40 }, (_, i) => at(0.55 + i * 0.008, 0.62 + Math.sin(i / 4) * 0.04));
  send('annotate', { shape: 'path', points: wave, label: 'Freehand', color: 'white', duration: 14 });
  send('region', { x: W * 0.62, y: H * 0.42, width: W * 0.2, height: H * 0.1, analyzing: true });
  await wait(1500);
  controller.showError(Object.assign(new Error('This is what an error looks like: the message types itself out so you can read it as it appears.'), { title: 'Something went wrong' }));
  controller.setState('processing');
  await wait(2500);
  controller.setState('listening');
  await wait(2500);
  controller.setState('responding');
  windows.broadcast('bubble', { text: 'Here’s the answer, typed out next to your cursor just like this.', ttl: 0 });
  await wait(5000);
  windows.broadcast('bubble', { text: '', ttl: 0 });
  send('region', null);
  controller.setState('idle');
}

/** Headless check that the engine can draw a traced outline onto a real screenshot. */
async function checkOutline({ audio, logger }) {
  const { ScreenTarget } = require('./capture');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  await wait(3000);
  try {
    const target = new ScreenTarget(screen.getPrimaryDisplay());
    const png = await target.screenshot();
    const { width: w, height: h } = target.sent;
    const points = Array.from({ length: 48 }, (_, i) => {
      const t = (i / 48) * Math.PI * 2;
      return [w * 0.5 + Math.cos(t) * w * 0.15, h * 0.5 + Math.sin(t) * h * 0.12];
    });
    const out = Buffer.from(await audio.call('mark-image', { png, points }, 15000));
    const file = path.join(os.tmpdir(), 'bigfoot-outline-check.png');
    fs.writeFileSync(file, out);
    logger.info(`outline check wrote ${file} (${out.length} bytes)`);
  } catch (err) {
    logger.error('outline check failed', err);
  }
  require('electron').app.quit();
}

/** Live check: move the real cursor to screenshot points and confirm it lands where mapped. */
async function checkPrecision({ input, logger }) {
  const { ScreenTarget } = require('./capture');
  await wait(2500);
  const lines = [];
  try {
    await input.start();
    const start = await input.cursor();
    for (const display of screen.getAllDisplays()) {
      for (const edge of [1920, 1366]) {
        const t = new ScreenTarget(display, edge);
        let worst = 0;
        let misses = 0;
        for (const fx of [0.02, 0.5, 0.98]) {
          for (const fy of [0.02, 0.5, 0.98]) {
            const s = [Math.floor(t.sent.width * fx), Math.floor(t.sent.height * fy)];
            const want = t.sentToPhysical(s);
            await input.move(want.x, want.y);
            const got = await input.cursor();
            worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y));
            const back = t.physicalToSent(got);
            if (back.x !== s[0] || back.y !== s[1]) misses++;
          }
        }
        lines.push(`display ${display.id} ${display.bounds.width}x${display.bounds.height}@${display.scaleFactor * 100}% shot ${t.sent.width}x${t.sent.height}: worst cursor error ${worst.toFixed(1)}px, round-trip misses ${misses}/9`);
      }
    }
    await input.move(start.x, start.y);
  } catch (err) {
    lines.push(`precision check failed: ${err.message}`);
  }
  lines.forEach((l) => logger.info(`precision: ${l}`));
  require('electron').app.quit();
}

/** Render each page of the main window off-screen and save it, without disturbing the user. */
async function snapPages({ windows, logger }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const pages = ['onboarding', 'home', 'assistant', 'account', 'voice', 'listening', 'safety', 'general', 'terminal'];
  const outDir = path.join(os.tmpdir(), 'bigfoot-snaps');
  fs.mkdirSync(outDir, { recursive: true });
  for (const page of pages) {
    const win = windows.openMain(page);
    win.setPosition(-4000, 0); // keep it off the user's screen
    await wait(1800);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${page}.png`), img.toPNG());
  }
  logger.info(`snapshots written to ${outDir}`);
  require('electron').app.quit();
}

module.exports = { runDemo, checkOutline, checkPrecision, snapPages };
