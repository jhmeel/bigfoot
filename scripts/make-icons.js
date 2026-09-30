'use strict';
// Renders the app and tray icons. Run with: npx electron scripts/make-icons.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'src', 'renderer', 'assets');
const BUILD = path.join(ROOT, 'build');

// Drawn in a page so we get real canvas anti-aliasing and blur.
const DRAW = `
function squircle(ctx, s, r) {
  const k = 0.5523 * r * 1.28; // slightly superelliptic corners, closer to Apple's icon shape
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(s - r, 0);
  ctx.bezierCurveTo(s - r + k, 0, s, r - k, s, r);
  ctx.lineTo(s, s - r);
  ctx.bezierCurveTo(s, s - r + k, s - r + k, s, s - r, s);
  ctx.lineTo(r, s);
  ctx.bezierCurveTo(r - k, s, 0, s - r + k, 0, s - r);
  ctx.lineTo(0, r);
  ctx.bezierCurveTo(0, r - k, r - k, 0, r, 0);
  ctx.closePath();
}
// Panda paw: a heart-bottomed main pad and five toe beans (pandas are bears, so five digits).
const TOES = [
  { x: 0.245, y: 0.475, rx: 0.068, ry: 0.086, rot: -38 },
  { x: 0.335, y: 0.325, rx: 0.07, ry: 0.092, rot: -20 },
  { x: 0.5, y: 0.268, rx: 0.072, ry: 0.094, rot: 0 },
  { x: 0.665, y: 0.325, rx: 0.07, ry: 0.092, rot: 20 },
  { x: 0.755, y: 0.475, rx: 0.068, ry: 0.086, rot: 38 },
];
function pawPath(ctx, ox, oy, w) {
  const P = (x, y) => [ox + x * w, oy + y * w];
  ctx.beginPath();
  ctx.moveTo(...P(0.5, 0.47));
  ctx.bezierCurveTo(...P(0.66, 0.47), ...P(0.8, 0.6), ...P(0.76, 0.72));
  ctx.bezierCurveTo(...P(0.73, 0.81), ...P(0.62, 0.83), ...P(0.56, 0.8));
  ctx.bezierCurveTo(...P(0.53, 0.785), ...P(0.51, 0.775), ...P(0.5, 0.775));
  ctx.bezierCurveTo(...P(0.49, 0.775), ...P(0.47, 0.785), ...P(0.44, 0.8));
  ctx.bezierCurveTo(...P(0.38, 0.83), ...P(0.27, 0.81), ...P(0.24, 0.72));
  ctx.bezierCurveTo(...P(0.2, 0.6), ...P(0.34, 0.47), ...P(0.5, 0.47));
  ctx.closePath();
  for (const t of TOES) {
    const [cx, cy] = P(t.x, t.y);
    ctx.moveTo(cx + t.rx * w, cy);
    ctx.ellipse(cx, cy, t.rx * w, t.ry * w, t.rot * Math.PI / 180, 0, Math.PI * 2);
  }
}
function paw(ctx, ox, oy, w, { outline = 0 } = {}) {
  if (outline) {
    pawPath(ctx, ox, oy, w);
    ctx.lineJoin = 'round';
    ctx.lineWidth = outline * 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
  }
  pawPath(ctx, ox, oy, w);
  const g = ctx.createLinearGradient(0, oy + w * 0.2, 0, oy + w * 0.85);
  g.addColorStop(0, '#3a3e46');
  g.addColorStop(1, '#0d0e11');
  ctx.fillStyle = g;
  ctx.fill();
  if (w >= 64) {
    // soft gloss on each pad
    ctx.save();
    pawPath(ctx, ox, oy, w);
    ctx.clip();
    const hl = ctx.createLinearGradient(0, oy + w * 0.2, 0, oy + w * 0.6);
    hl.addColorStop(0, 'rgba(255,255,255,0.22)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.fillRect(ox, oy, w, w * 0.6);
    ctx.restore();
  }
}
function appIcon(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const pad = size * 0.06;
  const s = size - pad * 2;
  ctx.translate(pad, pad);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = size * 0.035;
  ctx.shadowOffsetY = size * 0.012;
  squircle(ctx, s, s * 0.225);
  const bg = ctx.createLinearGradient(0, 0, 0, s);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(1, '#e7ebf0');
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.restore();
  squircle(ctx, s, s * 0.225);
  ctx.save();
  ctx.clip();
  const bamboo = ctx.createRadialGradient(s * 0.5, s * 1.05, 0, s * 0.5, s * 1.05, s * 0.75);
  bamboo.addColorStop(0, 'rgba(126,211,150,0.38)');
  bamboo.addColorStop(1, 'rgba(126,211,150,0)');
  ctx.fillStyle = bamboo;
  ctx.fillRect(0, 0, s, s);
  ctx.restore();
  squircle(ctx, s, s * 0.225);
  ctx.lineWidth = Math.max(1, size / 256);
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.stroke();

  const w = s * 0.78;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = s * 0.03;
  ctx.shadowOffsetY = s * 0.015;
  paw(ctx, (s - w) / 2, (s - w) / 2 + s * 0.035, w);
  ctx.restore();
  return c.toDataURL('image/png');
}
function trayIcon(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const w = size * 1.04;
  paw(ctx, (size - w) / 2, (size - w) / 2 + size * 0.02, w, { outline: size / 16 });
  return c.toDataURL('image/png');
}
`;

/** ICO container with PNG-compressed entries (supported since Windows Vista). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  try {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  await win.webContents.executeJavaScript(DRAW);
  const render = async (fn, size) => {
    const url = await win.webContents.executeJavaScript(`${fn}(${size})`);
    return Buffer.from(url.split(',')[1], 'base64');
  };

  fs.mkdirSync(ASSETS, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });
  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const icoImages = [];
  for (const size of icoSizes) icoImages.push({ size, png: await render('appIcon', size) });
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(icoImages));
  fs.writeFileSync(path.join(BUILD, 'icon.png'), await render('appIcon', 512));
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), await render('appIcon', 256));
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), await render('trayIcon', 16));
  fs.writeFileSync(path.join(ASSETS, 'tray@2x.png'), await render('trayIcon', 32));
  console.log('icons written');
  } catch (err) {
    console.error('icon generation failed:', err);
    process.exitCode = 1;
  }
  app.quit();
});
