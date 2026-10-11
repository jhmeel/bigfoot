'use strict';
// Client for the native input helper (src/main/native/input-helper.exe).

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const readline = require('readline');

// xdotool-style key names (what Claude sends) -> Windows virtual-key codes.
const VK = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, kp_enter: 0x0d, shift: 0x10, ctrl: 0x11,
  alt: 0x12, pause: 0x13, capslock: 0x14, caps_lock: 0x14, esc: 0x1b, escape: 0x1b, space: 0x20,
  pageup: 0x21, page_up: 0x21, prior: 0x21, pagedown: 0x22, page_down: 0x22, next: 0x22,
  end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28, print: 0x2c,
  insert: 0x2d, delete: 0x2e, win: 0x5b, menu: 0x5d, multiply: 0x6a, add: 0x6b, subtract: 0x6d,
  decimal: 0x6e, divide: 0x6f, numlock: 0x90, scrolllock: 0x91,
  semicolon: 0xba, plus: 0xbb, equal: 0xbb, comma: 0xbc, minus: 0xbd, period: 0xbe, slash: 0xbf,
  grave: 0xc0, bracketleft: 0xdb, backslash: 0xdc, bracketright: 0xdd, apostrophe: 0xde,
  volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad,
};
const ALIASES = {
  control: 'ctrl', control_l: 'ctrl', control_r: 'ctrl', ctl: 'ctrl', shift_l: 'shift', shift_r: 'shift',
  alt_l: 'alt', alt_r: 'alt', option: 'alt', super: 'win', super_l: 'win', super_r: 'win', meta: 'win',
  cmd: 'ctrl', command: 'ctrl', // on Windows the equivalent of Command shortcuts is Ctrl
  windows: 'win', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  del: 'delete', ins: 'insert', spacebar: 'space', ' ': 'space', 'caps lock': 'capslock',
};
const PUNCT = { ';': 'semicolon', '=': 'equal', ',': 'comma', '-': 'minus', '.': 'period', '/': 'slash',
  '`': 'grave', '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', "'": 'apostrophe', '+': 'plus' };

function keyToVk(name) {
  let k = name.trim().toLowerCase() || name.toLowerCase();
  k = ALIASES[k] || PUNCT[k] || k;
  if (k in VK) return VK[k];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k)) return 0x70 + Number(k.slice(1)) - 1;
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  if (/^kp_[0-9]$/.test(k)) return 0x60 + Number(k.slice(3));
  throw new Error(`Unknown key "${name}"`);
}

/** "ctrl+Shift+t" -> ['ctrl','shift','t'];  "ctrl++" -> ['ctrl','+'] */
function splitCombo(combo) {
  const text = String(combo);
  if (text.trim() === '+') return ['+'];
  const parts = text.split('+').filter((p) => p.length > 0);
  if (text.trimEnd().endsWith('++')) parts.push('+');
  return parts;
}

function comboToVks(combo) {
  const keys = splitCombo(combo);
  if (!keys.length) throw new Error('No keys given');
  const vks = [];
  for (const key of keys) {
    if (key === '+' || key.toLowerCase() === 'plus') vks.push(VK.shift, VK.equal); // "+" is Shift+= on US layouts
    else vks.push(keyToVk(key));
  }
  return [...new Set(vks)];
}

class InputHelper extends EventEmitter {
  constructor(exePath) {
    super();
    this.exePath = exePath || defaultHelperPath();
    this.pending = new Map();
    this.nextId = 1;
    this.proc = null;
    this.ready = null;
    this.stopping = false;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn(this.exePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      const timer = setTimeout(() => reject(new Error('Input helper did not start in time')), 8000);
      proc.on('error', (err) => { clearTimeout(timer); this.ready = null; reject(err); });
      proc.on('exit', (code) => {
        this.proc = null;
        this.ready = null;
        for (const { reject: rej } of this.pending.values()) rej(new Error('Input helper stopped'));
        this.pending.clear();
        if (!this.stopping) {
          this.emit('crash', code);
          setTimeout(() => this.start().catch((e) => this.emit('error', e)), 1000);
        }
      });
      proc.stderr.on('data', (d) => console.error('[input-helper]', d.toString().trim()));
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        const [id, status, ...rest] = line.split('|');
        if (id === '!') {
          if (status === 'ready') { clearTimeout(timer); resolve(); }
          else if (status === 'keys') {
            const [ctrl, alt, shift, win] = (rest[0] || '0,0,0,0').split(',').map((v) => v === '1');
            this.emit('keys', { ctrl, alt, shift, win });
          } else if (status === 'esc') this.emit('esc');
          else if (status === 'wake') this.emit('wake', Number(rest[0]) || 0);
          else if (status === 'dblclick') {
            const [x, y] = (rest[0] || '').split(',').map(Number);
            if (Number.isFinite(x) && Number.isFinite(y)) this.emit('dblclick', { x, y });
          }
          return;
        }
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (status === 'ok') entry.resolve(rest.join('|'));
        else entry.reject(new Error(rest.join('|') || 'Input failed'));
      });
    });
    return this.ready;
  }

  async send(...parts) {
    await this.start();
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write([id, ...parts].join('|') + '\n');
    });
  }

  stop() {
    this.stopping = true;
    if (this.proc) this.proc.kill();
  }

  // commands (coordinates are physical screen pixels)
  move(x, y) { return this.send('move', Math.round(x), Math.round(y)); }
  click(button = 'left', count = 1) { return this.send('click', button, count); }
  mouseDown(button = 'left') { return this.send('down', button); }
  mouseUp(button = 'left') { return this.send('up', button); }
  scroll(dx, dy) { return this.send('scroll', Math.round(dx), Math.round(dy)); }
  keys(combo, repeat = 1) { return this.send('keys', comboToVks(combo).join(','), repeat); }
  keyDown(combo) { return this.send('keydown', comboToVks(combo).join(',')); }
  keyUp(combo) { return this.send('keyup', comboToVks(combo).join(',')); }
  type(text) { return this.send('type', Buffer.from(String(text), 'utf8').toString('base64')); }
  async cursor() {
    const [x, y] = (await this.send('pos')).split(',').map(Number);
    return { x, y };
  }
  /** Start offline wake-word spotting; resolves to the recognizer's language. */
  wake(names) { return this.send('wake', Buffer.from(names.join(','), 'utf8').toString('base64')); }
  wakeOff() { return this.send('wake-off'); }
  watchDesktopDoubleClick(on) { return this.send('dblclick', on ? '1' : '0'); }

  /**
   * Windows handwriting recognition. strokes: [[{x, y}, ...], ...].
   * Resolves to segments in writing order, each a list of candidate readings, best first.
   */
  async recognizeInk(strokes) {
    const payload = strokes
      .map((s) => s.map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`).join(' '))
      .join(';');
    const text = Buffer.from(await this.send('ink', Buffer.from(payload, 'utf8').toString('base64')), 'base64').toString('utf8');
    return text ? text.split('\u001e').map((seg) => seg.split('\u001f').filter(Boolean)) : [];
  }

  /** Handwritten math → MathML, by Windows' Math Recognizer. Throws when it isn't installed. */
  async recognizeMath(strokes) {
    const payload = strokes
      .map((s) => s.map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`).join(' '))
      .join(';');
    return Buffer.from(await this.send('mathink', Buffer.from(payload, 'utf8').toString('base64')), 'base64').toString('utf8');
  }

  /** Bring one of Bigfoot's own windows to the foreground (it needs the keyboard). */
  async activate(hwnd) {
    return (await this.send('activate', String(hwnd))) === '1';
  }

  async windowTitle() {
    return Buffer.from(await this.send('title'), 'base64').toString('utf8');
  }
}

function defaultHelperPath() {
  // Packaged builds unpack native/ out of the asar archive so the exe can run.
  return path.join(__dirname, 'native', 'input-helper.exe').replace('app.asar', 'app.asar.unpacked');
}

module.exports = { InputHelper, keyToVk, comboToVks, splitCombo };
