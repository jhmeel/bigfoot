'use strict';
// Offline speech recognition with whisper.cpp, which ships inside Bigfoot. Its server is kept
// loaded like the AI model, so a sentence is transcribed in about two seconds even on a laptop
// without a graphics card.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { SPEECH, WHISPER_MODELS } = require('./catalog');
const { downloadFile, sha256File } = require('./download');

// Generous: on a PC short of memory (the AI loading at the same time) Whisper starts slowly.
const START_TIMEOUT_MS = 180000;
const TRANSCRIBE_TIMEOUT_MS = 120000;
const SPEECH_HINT = 'Hey Bigfoot, open Chrome, Microsoft Edge, or the browser and search for the nearest restaurant. Open Spotify and play music on YouTube. Draw a circle on the screen. Open Notepad, WhatsApp, Word, Excel, File Explorer, settings, or terminal.';

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

function speechDir() {
  return app && app.isPackaged ? path.join(process.resourcesPath, 'speech') : path.join(__dirname, '..', '..', '..', 'vendor', 'speech');
}

function userSpeechDir() {
  return app ? path.join(app.getPath('userData'), 'speech') : speechDir();
}

function targetModelDir() {
  const bundled = speechDir();
  if (app && app.isPackaged) {
    const dir = userSpeechDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  const dir = userSpeechDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The bundled recognizer: app resources when installed, vendor/speech when run from source. */
function speechPaths(modelId, settings) {
  const base = speechDir();
  const server = path.join(base, 'whisper', 'whisper-server.exe');
  if (!fs.existsSync(server)) return null;

  const targetId = modelId || (settings && settings.get('whisperModel')) || 'small.en';
  const m = (WHISPER_MODELS && WHISPER_MODELS.find((x) => x.id === targetId)) || (WHISPER_MODELS && WHISPER_MODELS[0]);
  if (!m) return null;

  const candidates = [
    path.join(base, m.file),
    app ? path.join(app.getPath('userData'), 'speech', m.file) : null,
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size === m.size) return { server, model: p, cwd: path.dirname(server), modelDef: m };
    } catch {}
  }
  return null;
}

class SpeechService extends EventEmitter {
  constructor({ logger, settings } = {}) {
    super();
    this.logger = logger;
    this.settings = settings;
    this.state = 'stopped';
    this.proc = null;
    this.base = null;
    this.starting = null;
    this.downloadingId = null;
    this.downloadProgress = null;
  }

  findModelFile(m) {
    if (!m || !m.file) return null;
    const candidates = [
      path.join(speechDir(), m.file),
      app ? path.join(app.getPath('userData'), 'speech', m.file) : null,
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).size === m.size) return p;
      } catch {}
    }
    return null;
  }

  activeModel() {
    const saved = this.settings && this.settings.get('whisperModel');
    if (saved) {
      const found = WHISPER_MODELS.find((m) => m.id === saved);
      if (found) return found;
    }
    const small = WHISPER_MODELS.find((m) => m.id === 'small.en');
    if (this.findModelFile(small)) return small;
    const base = WHISPER_MODELS.find((m) => m.id === 'base.en');
    if (this.findModelFile(base)) return base;
    return small || WHISPER_MODELS[0];
  }

  speechPaths() {
    const base = speechDir();
    const server = path.join(base, 'whisper', 'whisper-server.exe');
    if (!fs.existsSync(server)) return null;
    const modelDef = this.activeModel();
    const model = this.findModelFile(modelDef);
    return model ? { server, model, cwd: path.dirname(server), modelDef } : null;
  }

  get available() { return Boolean(this.speechPaths()); }

  listModels() {
    const active = this.activeModel();
    return WHISPER_MODELS.map((m) => {
      const file = this.findModelFile(m);
      return {
        id: m.id,
        label: m.label,
        size: m.size,
        note: m.note,
        installed: Boolean(file),
        active: m.id === active.id,
        downloading: this.downloadingId === m.id,
        progress: this.downloadingId === m.id ? this.downloadProgress : null,
      };
    });
  }

  async downloadModel(m) {
    if (this.downloadingId) {
      throw new Error(`Another model is currently downloading (${this.downloadingId})`);
    }
    this.downloadingId = m.id;
    this.downloadProgress = 0;
    this.emit('progress', { id: m.id, percent: 0 });

    try {
      const targetDir = targetModelDir();
      const targetPath = path.join(targetDir, m.file);
      const destPart = targetPath + '.part';

      await downloadFile({
        url: m.url,
        dest: destPart,
        size: m.size,
        onBytes: (_chunk, total) => {
          const pct = Math.min(99, Math.round((total / m.size) * 100));
          if (pct !== this.downloadProgress) {
            this.downloadProgress = pct;
            this.emit('progress', { id: m.id, percent: pct });
          }
        },
      });

      const hash = await sha256File(destPart);
      if (hash !== m.sha256) {
        try { fs.unlinkSync(destPart); } catch {}
        throw new Error(`Model hash verification failed for ${m.label}.`);
      }
      fs.renameSync(destPart, targetPath);
      this.downloadProgress = 100;
      this.emit('progress', { id: m.id, percent: 100 });
      return targetPath;
    } finally {
      this.downloadingId = null;
      this.downloadProgress = null;
    }
  }

  async pickModel(id) {
    const m = WHISPER_MODELS.find((x) => x.id === id);
    if (!m) throw new Error(`Unknown model ${id}`);

    let modelPath = this.findModelFile(m);
    if (!modelPath) {
      await this.downloadModel(m);
      modelPath = this.findModelFile(m);
      if (!modelPath) throw new Error(`Failed to verify ${m.label} after download.`);
    }

    if (this.settings) {
      this.settings.update({ whisperModel: id });
    }

    await this.stopAsync();
    await this.ensure();
    return { ok: true, id };
  }

  preload() {
    if (this.available) this.ensure().catch(() => {});
  }

  async ensure() {
    if (this.base) return this.base;
    if (!this.starting) {
      this.setState('loading');
      this.starting = this.launch()
        .then((base) => { this.setState('ready'); return base; })
        .catch((err) => {
          this.setState('failed', err.message);
          if (this.logger) this.logger.error('Speech recognizer failed to start', err.message);
          throw err;
        })
        .finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  setState(state, message = '') {
    this.state = state;
    this.emit('state', { state, message });
  }

  async launch() {
    const files = this.speechPaths();
    if (!files) {
      const baseDir = speechDir();
      const server = path.join(baseDir, 'whisper', 'whisper-server.exe');
      if (fs.existsSync(server)) {
        const model = this.activeModel();
        throw new Error(`The speech model ${model.label} is not installed yet.`);
      }
      throw new Error('The speech recognizer is missing from this installation. Reinstall Bigfoot to restore it.');
    }
    this.stopping = false;
    const port = await freePort();
    const threads = Math.max(2, Math.round(os.cpus().length / 2) - 1);
    const proc = spawn(files.server, ['-m', files.model, '--host', '127.0.0.1', '--port', String(port), '-l', 'en', '-nt', '-t', String(threads)],
      { cwd: files.cwd, windowsHide: true, stdio: 'ignore' });
    this.proc = proc;
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not critical */ }
    proc.once('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.base = null;
      this.setState('stopped');
      const now = Date.now();
      this.crashes = (this.crashes || []).filter((t) => now - t < 10 * 60 * 1000);
      if (!this.stopping && this.crashes.length < 3) { this.crashes.push(now); setTimeout(() => this.preload(), 2000); } // it crashed: bring it back
    });
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
    // Context for the recognizer: the words people say to Bigfoot ("big food", "such for" were heard
    // instead of "Bigfoot", "search for"). Whisper uses it as the text that came before.
    form.append('prompt', SPEECH_HINT);
    const res = await fetch(`${base}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`speech recognizer returned ${res.status}`);
    return cleanTranscript((await res.json()).text);
  }

  stop() {
    this.stopping = true;
    this.base = null;
    if (this.proc) { try { this.proc.kill(); } catch { /* gone */ } this.proc = null; }
  }

  async stopAsync() {
    this.stopping = true;
    this.base = null;
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try { proc.kill(); } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

/** Whisper marks silence and noises in brackets ("[BLANK_AUDIO]", "(music)"); those aren't words. */
function cleanTranscript(text) {
  return String(text || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { SpeechService, cleanTranscript, speechPaths };
