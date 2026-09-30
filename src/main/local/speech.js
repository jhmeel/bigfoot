'use strict';
// Offline speech recognition with whisper.cpp, which ships inside Bigfoot. Its server is kept
// loaded like the AI model, so a sentence is transcribed in about two seconds even on a laptop
// without a graphics card.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { SPEECH } = require('./catalog');

const START_TIMEOUT_MS = 60000;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** The bundled recognizer: app resources when installed, vendor/speech when run from source. */
function speechPaths() {
  const base = app && app.isPackaged ? path.join(process.resourcesPath, 'speech') : path.join(__dirname, '..', '..', '..', 'vendor', 'speech');
  const server = path.join(base, 'whisper', 'whisper-server.exe');
  const model = path.join(base, SPEECH.find((f) => f.speech).name);
  return fs.existsSync(server) && fs.existsSync(model) ? { server, model, cwd: path.dirname(server) } : null;
}

class SpeechService {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.proc = null;
    this.base = null;
    this.starting = null;
  }

  get available() { return Boolean(speechPaths()); }

  preload() {
    if (this.available) this.ensure().catch(() => {});
  }

  async ensure() {
    if (this.base) return this.base;
    if (!this.starting) this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  async launch() {
    const files = speechPaths();
    if (!files) throw new Error('The speech recognizer is missing from this installation. Reinstall Bigfoot to restore it.');
    const port = await freePort();
    const threads = Math.max(2, Math.round(os.cpus().length / 2) - 1);
    const proc = spawn(files.server, ['-m', files.model, '--host', '127.0.0.1', '--port', String(port), '-l', 'en', '-nt', '-t', String(threads)],
      { cwd: files.cwd, windowsHide: true, stdio: 'ignore' });
    this.proc = proc;
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not critical */ }
    proc.once('exit', () => { if (this.proc === proc) { this.proc = null; this.base = null; } });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error('The speech recognizer stopped while starting.');
      try { await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) }); this.base = base; return base; } catch { /* loading */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    this.stop();
    throw new Error('The speech recognizer took too long to start.');
  }

  /** Text for a 16 kHz mono WAV recording. */
  async transcribe(wav) {
    const base = await this.ensure();
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const res = await fetch(`${base}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`speech recognizer returned ${res.status}`);
    return cleanTranscript((await res.json()).text);
  }

  stop() {
    this.base = null;
    if (this.proc) { try { this.proc.kill(); } catch { /* gone */ } this.proc = null; }
  }
}

/** Whisper marks silence and noises in brackets ("[BLANK_AUDIO]", "(music)"); those aren't words. */
function cleanTranscript(text) {
  return String(text || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { SpeechService, cleanTranscript, speechPaths };
