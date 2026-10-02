'use strict';
// Real terminals: PowerShell, Command Prompt, PowerShell 7 and Git Bash in a pseudo-console (the
// same technology as VS Code's terminal), so colours, prompts, interactive programs and Ctrl+C all
// work. The user types in them on the Terminal page; the AI runs its commands in a "Bigfoot" tab
// the user can watch, and starts dev servers in tabs of their own.

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BUFFER = 400 * 1024; // what's kept per terminal, for replay and for the AI to read
const FLUSH_MS = 8;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r(?!\n)/g;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/gi;

const strip = (s) => String(s).replace(ANSI, '');

function which(file, dirs) {
  for (const d of dirs) {
    const p = path.join(d, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** The shells on this PC, the default first. */
function availableShells() {
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathDirs = String(process.env.PATH || '').split(';').filter(Boolean);
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const list = [
    { id: 'powershell', name: 'PowerShell', file: path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] },
    { id: 'pwsh', name: 'PowerShell 7', file: which('pwsh.exe', [...pathDirs, ...pf.map((p) => path.join(p, 'PowerShell', '7'))]), args: ['-NoLogo'] },
    { id: 'cmd', name: 'Command Prompt', file: path.join(sys, 'cmd.exe'), args: [] },
    { id: 'bash', name: 'Git Bash', file: which('bash.exe', pf.map((p) => path.join(p, 'Git', 'bin'))), args: ['--login', '-i'] },
  ];
  return list.filter((s) => s.file && fs.existsSync(s.file));
}

class Terminals extends EventEmitter {
  constructor({ logger = null, pty = null } = {}) {
    super();
    this.logger = logger;
    this.pty = pty;
    this.sessions = new Map();
    this.nextId = 1;
    this.shellList = null;
  }

  shells() {
    if (!this.shellList) this.shellList = availableShells();
    return this.shellList.map(({ id, name }) => ({ id, name }));
  }

  ptyModule() {
    if (!this.pty) this.pty = require('@lydell/node-pty');
    return this.pty;
  }

  /** Open a terminal. owner 'ai' marks the ones the AI runs in. */
  create({ shell = 'powershell', cwd = os.homedir(), name = '', owner = 'user', cols = 100, rows = 30 } = {}) {
    const choice = (this.shellList || availableShells()).find((s) => s.id === shell) || availableShells()[0];
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const env = { ...process.env, TERM_PROGRAM: 'Bigfoot', COLORTERM: 'truecolor', FORCE_COLOR: '1' };
    const proc = this.ptyModule().spawn(choice.file, choice.args, { name: 'xterm-256color', cols, rows, cwd: dir, env, useConpty: true });
    const id = this.nextId++;
    const s = {
      id, name: name || choice.name, shell: choice.id, owner, cwd: dir, proc, buffer: '', text: '',
      textBase: 0, exited: false, exitCode: null, urls: [], busy: false, started: Date.now(), pending: '', flushTimer: null,
    };
    proc.onData((data) => this.onData(s, data));
    proc.onExit(({ exitCode }) => {
      this.flush(s);
      s.exited = true;
      s.exitCode = exitCode;
      this.emit('exit', { id, exitCode });
      this.emit('list', this.list());
    });
    this.sessions.set(id, s);
    this.emit('list', this.list());
    return this.info(s);
  }

  onData(s, data) {
    s.buffer += data;
    if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER);
    const plain = strip(data);
    s.text += plain;
    if (s.text.length > MAX_BUFFER) { // positions count from the very start, so they survive trimming
      s.textBase += s.text.length - MAX_BUFFER;
      s.text = s.text.slice(-MAX_BUFFER);
    }
    // Dev servers print their address: offer it as a link (and tell the AI). Output arrives in
    // pieces that can split an address, so only whole lines are looked at.
    const lines = (s.partial || '') + plain;
    const cut = lines.lastIndexOf('\n');
    s.partial = cut < 0 ? lines.slice(-2000) : lines.slice(cut + 1).slice(-2000);
    for (const m of (cut < 0 ? '' : lines.slice(0, cut)).matchAll(LOCAL_URL)) {
      const url = m[0].replace(/[.,;:]+$/, '').replace('0.0.0.0', 'localhost');
      if (!s.urls.includes(url)) {
        s.urls.push(url);
        this.emit('url', { id: s.id, url });
        this.emit('list', this.list());
      }
    }
    // Sent in small batches: a build printing thousands of lines stays smooth.
    s.pending += data;
    if (!s.flushTimer) s.flushTimer = setTimeout(() => this.flush(s), FLUSH_MS);
    this.emit('text', { id: s.id, text: plain });
  }

  flush(s) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
    if (!s.pending) return;
    const data = s.pending;
    s.pending = '';
    this.emit('data', { id: s.id, data });
  }

  get(id) {
    const s = this.sessions.get(Number(id));
    if (!s) throw new Error(`There's no terminal ${id}. List them with the terminal tool.`);
    return s;
  }

  info(s) {
    return { id: s.id, name: s.name, shell: s.shell, owner: s.owner, cwd: s.cwd, exited: s.exited, exitCode: s.exitCode, urls: s.urls, busy: s.busy };
  }

  list() { return [...this.sessions.values()].map((s) => this.info(s)); }

  write(id, data) {
    const s = this.sessions.get(Number(id));
    if (s && !s.exited) s.proc.write(String(data));
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(Number(id));
    if (!s || s.exited) return;
    try { s.proc.resize(Math.max(20, Math.min(500, cols | 0)), Math.max(5, Math.min(200, rows | 0))); } catch { /* closing */ }
  }

  /** Everything the terminal has shown (with colours), for a window that opens it later. */
  replay(id) {
    const s = this.sessions.get(Number(id));
    return s ? s.buffer : '';
  }

  /** The last lines, without colour codes. */
  tail(id, lines = 60) {
    const s = this.get(id);
    return s.text.split(/\r?\n/).slice(-Math.max(1, Math.min(lines, 400))).join('\n').trim();
  }

  /** Resolves once the shell shows its first prompt (or after a few seconds). */
  async ready(id, maxMs = 5000) {
    const s = this.get(id);
    const until = Date.now() + maxMs;
    const prompt = /(?:PS [^\n]*>|[>$#])\s*$/; // PowerShell, cmd, bash
    while (Date.now() < until && !s.exited && !prompt.test(s.text)) await new Promise((r) => setTimeout(r, 50));
  }

  /** Ctrl+C, then close the terminal if asked. */
  interrupt(id) {
    const s = this.get(id);
    if (!s.exited) s.proc.write('\x03');
  }

  close(id) {
    const s = this.sessions.get(Number(id));
    if (!s) return;
    if (!s.exited) {
      try { s.proc.kill(); } catch { /* gone */ }
    }
    this.sessions.delete(s.id);
    this.emit('list', this.list());
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  /**
   * Run a command in a PowerShell terminal and wait for it to finish. The command goes into a script
   * file (any length, several lines), and a marker the screen echo can't contain says when it's done.
   * @returns {Promise<{ done: boolean, exitCode: number|null, output: string }>}
   */
  run(id, command, { cwd = null, timeoutMs = 120000, signal = null } = {}) {
    const s = this.get(id);
    if (s.exited) throw new Error('That terminal has closed.');
    if (s.shell !== 'powershell' && s.shell !== 'pwsh') throw new Error('Commands run in a PowerShell terminal.');
    const n = `${s.id}${Date.now().toString(36)}`;
    const dir = path.join(os.tmpdir(), 'bf');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${n}.ps1`); // the command, as written
    const runner = path.join(dir, `${n}r.ps1`); // runs it and reports how it ended
    const q = (p) => `'${String(p).replace(/'/g, "''")}'`;
    fs.writeFileSync(file, `\ufeff${cwd ? `Set-Location -LiteralPath ${q(cwd)}\r\n` : ''}${command}\r\n`, 'utf8');
    // Any ending reports back: success, an exit code, an error, even a syntax error in the command.
    // The report is printed invisibly (SGR 8) so the terminal stays clean.
    // First it shows what it's running (the line typed into the terminal is just the script's path).
    const shown = String(command).split(/\r?\n/).filter((l) => l.trim());
    const show = [...shown.slice(0, 8), ...(shown.length > 8 ? [`\u2026 ${shown.length - 8} more lines`] : [])]
      .map((l) => `Write-Host '\u203a ' -NoNewline -ForegroundColor DarkGray; Write-Host ${q(l.length > 200 ? `${l.slice(0, 199)}\u2026` : l)} -ForegroundColor Cyan`);
    fs.writeFileSync(runner, `\ufeff${[
      ...show,
      `Write-Host -NoNewline "$([char]27)[8m__BF_START_${n}$([char]27)[0m"`,
      '$ProgressPreference = "SilentlyContinue"; $global:LASTEXITCODE = 0; $bfErrors = $Error.Count; $bfFail = $false',
      `try { . ${q(file)} } catch { $bfFail = $true; Write-Host ($_ | Out-String) -ForegroundColor Red }`,
      'finally {',
      '  $bfCode = if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($bfFail -or $Error.Count -gt $bfErrors) { 1 } else { 0 }',
      `  Write-Host -NoNewline "$([char]27)[8m__BF_DONE_${n}_$bfCode$([char]27)[0m"`,
      '}',
    ].join('\r\n')}\r\n`, 'utf8');
    const marker = `__BF_DONE_${n}_`;
    const startAt = s.textBase + s.text.length;
    const since = () => s.text.slice(Math.max(0, startAt - s.textBase));
    s.busy = true;
    this.emit('list', this.list());
    s.proc.write(`. ${q(runner)}\r`);
    return new Promise((resolve) => {
      let timer = null;
      const finish = (done, exitCode) => {
        clearTimeout(timer);
        this.off('text', onText);
        if (signal) signal.removeEventListener('abort', onAbort);
        s.busy = false;
        this.emit('list', this.list());
        if (done) { fs.rm(file, { force: true }, () => {}); fs.rm(runner, { force: true }, () => {}); }
        let output = since();
        const at = output.indexOf(marker);
        if (at >= 0) output = output.slice(0, at);
        // The command's own output starts after the line that shows it.
        const begin = output.indexOf(`__BF_START_${n}`);
        output = (begin >= 0 ? output.slice(begin + `__BF_START_${n}`.length) : output.replace(/^[^\n]*\\bf\\[^\n]*r\.ps1'?[^\n]*\n?/m, '')).trim();
        resolve({ done, exitCode, output });
      };
      const onText = ({ id: sid }) => {
        if (sid !== s.id) return;
        const m = new RegExp(`${marker}(-?\\d+)`).exec(since());
        if (m) finish(true, Number(m[1]));
      };
      const onAbort = () => { this.interrupt(s.id); finish(false, null); };
      this.on('text', onText);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(false, null), timeoutMs);
    });
  }
}

module.exports = { Terminals, availableShells, strip };
