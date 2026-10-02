'use strict';
// Runs llama-server for the installed model: loopback only, per-session API key. By default it's
// loaded when Bigfoot starts and kept loaded (restarted if it crashes), so there's no cold start;
// with "Keep the AI loaded" off it unloads after IDLE_MS without use.

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const hardware = require('./hardware');

const IDLE_MS = 10 * 60 * 1000;
const START_TIMEOUT_MS = 8 * 60 * 1000; // no progress for this long: give up (a swapping PC goes quiet for minutes)
const MAX_LOAD_MS = 20 * 60 * 1000;
// What llama-server prints while loading, and roughly how far along that is.
const LOAD_PHASES = [
  [/common_params|system_info|init_listene|build:/, 7, 'Starting the AI engine'],
  [/load_model: loading model/, 12, 'Reading the model'],
  [/control-looking token|print_info|load_tensors/, 30, 'Loading the model'],
  [/threadpool init|llama_context|kv_cache/i, 55, 'Preparing memory'],
  [/clip_model_loader|mtmd|loaded multimodal/, 72, 'Loading vision'],
  [/initializing, n_slots/, 90, 'Almost ready'],
];
const LOG_LINES = 40;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

/**
 * Speed settings for this PC, from measurements on a laptop without a graphics card (i5-8350U,
 * UHD 620): the Vulkan backend on an integrated GPU read prompts at 3 tokens/s against 24–36 on the
 * CPU, pinning memory with mlock starved an 8 GB machine, and reading a screenshot fell from 113 s
 * to 26 s at 256 image tokens. So integrated GPUs run on the CPU with small images.
 */
function tuningFor(hw) {
  const vram = hw && hw.dedicated ? hw.vramGB : 0;
  const bigRam = hw && hw.ramGB >= 16;
  if (vram >= 6) return { imageTokens: 1024, edge: 1280, cpuOnly: false, lock: bigRam };
  if (vram > 0) return { imageTokens: 768, edge: 1280, cpuOnly: false, lock: bigRam };
  return { imageTokens: 256, edge: 1024, cpuOnly: true, lock: false };
}

/** Writing leaves a core for Windows and the user's apps, so the PC stays responsive while the model works. */
function threadCount() {
  const physical = Math.max(1, Math.round(os.cpus().length / 2));
  return Math.max(2, physical - 1);
}

/** Reading the request (the longest wait) uses every core: 21 instead of 18 words-pieces a second on a 4-core laptop. */
function batchThreadCount() {
  return Math.max(2, Math.round(os.cpus().length / 2));
}

class RuntimeError extends Error {
  constructor(message, title = 'Local AI unavailable') {
    super(message);
    this.title = title;
  }
}

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

// On 8 GB PCs the model, Windows, and a browser compete for memory; running short makes Windows
// swap and loading takes many minutes. There the working memory is smaller and compressed.
const lowMemory = () => os.totalmem() < 12 * 1024 ** 3;

function contextSize() {
  if (os.totalmem() >= 24 * 1024 ** 3) return 16384;
  // 8192 even with less memory: the 8-bit cache makes it about 150 MB more than 6144, and the
  // instructions and tools take about 4,900 of it.
  return 8192;
}

/** KV cache in 8 bits (half the memory, no visible quality loss) and a small prompt cache. */
function memoryArgs() {
  return lowMemory()
    // --no-repack: llama.cpp otherwise keeps a second, CPU-optimized copy of the weights.
    ? ['--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--cache-ram', '256', '--no-repack']
    : ['--cache-ram', '2048'];
}

class LocalRuntime extends EventEmitter {
  constructor({ manager, logger, settings = null, idleMs = IDLE_MS }) {
    super();
    Object.assign(this, { manager, logger, settings, idleMs });
    this.proc = null;
    this.starting = null;
    this.endpoint = null;
    this.slotHolds = null;
    this.idleTimer = null;
    this.log = [];
    this.busy = 0;
    this.tuning = tuningFor(null);
    this.restarts = [];
    this.noLock = false;
    manager.on('removing', () => this.stop());
    // A new model replaces the loaded one straight away; no restart needed.
    manager.on('removing', () => this.stop());
    manager.on('installed', () => { this.stop(); this.pruneCache(null); this.preload(); }); // old model's saved prompts too
  }

  get running() { return Boolean(this.endpoint); }

  /** Where the server saves a read prompt, so it doesn't have to read it again after a restart. */
  cacheDir() {
    const dir = path.join(this.manager.dir, 'cache');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Save or restore the server's conversation cache (slot 0) under a name. Never throws. */
  async slot(action, filename) {
    if (!this.endpoint) return false;
    try {
      const res = await fetch(`${this.endpoint.baseUrl}/slots/0?action=${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.endpoint.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
        signal: AbortSignal.timeout(60000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Keep only the newest saved prompt; older ones belong to a previous name or tool list. */
  pruneCache(keep) {
    try {
      for (const f of fs.readdirSync(this.cacheDir())) {
        if (f !== keep && f.endsWith('.bin')) fs.rmSync(path.join(this.cacheDir(), f), { force: true });
      }
    } catch { /* not critical */ }
  }

  get keepLoaded() { return !this.settings || this.settings.get('keepAiLoaded') !== false; }

  /** Load the model now if it should stay loaded (at startup, after install, after a crash). */
  preload() {
    if (this.keepLoaded && this.manager.paths()) this.ensure().catch(() => {});
  }

  /** Called when "Keep the AI loaded" changes. */
  applyKeepLoaded() {
    if (this.keepLoaded) this.preload();
    else this.touch();
  }

  /** Resolves to { baseUrl, apiKey, model, ctx }. */
  async ensure() {
    this.touch();
    if (this.endpoint) return this.endpoint;
    if (!this.starting) {
      this.starting = this.launch().finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  warm() {
    if (this.manager.paths()) this.ensure().catch(() => {});
  }

  /**
   * Requests to the model one at a time, in order. The server has a single conversation slot: a
   * math reading that slips in between reading the instructions and saving them would be saved in
   * their place, and every later request would re-read the instructions.
   * slotHolds names what the slot holds now (the saved instructions' file, or null).
   */
  exclusive(fn) {
    const run = (this.queue || Promise.resolve()).then(() => this.use(fn));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Keeps the server from idling out while fn runs. */
  async use(fn) {
    this.busy++;
    try {
      return await fn(await this.ensure());
    } finally {
      this.busy--;
      this.touch();
    }
  }

  touch() {
    clearTimeout(this.idleTimer);
    if (this.keepLoaded) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy > 0) { this.touch(); return; }
      if (this.endpoint && this.logger) this.logger.info('Unloading the local AI after inactivity');
      this.stop();
    }, this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  stop() {
    clearTimeout(this.idleTimer);
    this.endpoint = null;
    this.slotHolds = null;
    this.stopping = true;
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try { p.kill(); } catch { /* already gone */ }
    }
    this.emit('state', 'stopped');
  }

  async launch() {
    const files = this.manager.paths();
    if (!files) {
      const snap = this.manager.snapshot();
      if (snap.status !== 'none' && snap.status !== 'ready') {
        throw new RuntimeError(`Your local AI is still being set up (${Math.round((snap.fraction || 0) * 100)}%). You can follow it in Settings › Models.`, 'Local AI isn’t ready yet');
      }
      throw new RuntimeError('No local AI model is installed. Download one in Settings › Models.', 'Set up your local AI');
    }
    this.stopping = false;
    try {
      this.tuning = tuningFor(await hardware.detect());
    } catch { /* keep the conservative defaults */ }
    const port = await freePort();
    const apiKey = crypto.randomBytes(24).toString('hex');
    const ctx = contextSize();
    const args = [
      '--model', files.model, '--mmproj', files.mmproj,
      '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey,
      '--alias', files.id, '--ctx-size', String(ctx), '--parallel', '1',
      '--jinja', '--no-webui',
      '--image-max-tokens', String(this.tuning.imageTokens),
      '--cache-reuse', '256', // reuse cached context even after older screenshots are dropped
      '--batch-size', '512', // same speed (the compute chunk is 512 anyway), but progress is reported every 512 tokens
      '--threads', String(threadCount()), '--threads-batch', String(batchThreadCount()),
      '--slot-save-path', this.cacheDir(),
      ...memoryArgs(),
      ...(this.tuning.cpuOnly ? ['--device', 'none'] : []),
      ...(this.tuning.lock && !this.noLock ? ['--load-mode', 'mmap+mlock'] : []),
    ];
    this.log = [];
    this.emit('state', 'starting');
    if (this.logger) this.logger.info(`Starting the local AI: ${files.label}, ${ctx} context`);
    const proc = spawn(files.server, args, { cwd: files.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not critical */ }
    this.loadStarted = Date.now();
    this.lastPercent = 0;
    this.failed = null;
    this.progress(3, 'Starting');
    const keep = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.log.push(line.trim());
        const phase = LOAD_PHASES.find(([re]) => re.test(line));
        if (phase) this.progress(phase[1], phase[2]);
      }
      if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES);
    };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);

    const exited = new Promise((_, reject) => {
      proc.once('error', (err) => reject(new RuntimeError(`The local AI couldn’t start: ${err.message}`)));
      proc.once('exit', (code) => {
        const wasReady = this.proc === proc && Boolean(this.endpoint);
        if (this.proc === proc) { this.proc = null; this.endpoint = null; this.slotHolds = null; this.emit('state', 'stopped'); }
        if (wasReady && !this.stopping) this.recover(code);
        reject(new RuntimeError(explainExit(code, this.log)));
      });
    });
    exited.catch(() => {});

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await Promise.race([this.waitHealthy(baseUrl, apiKey), exited]);
    } catch (err) {
      if (this.proc === proc) this.stop();
      if (!this.noLock && /mlock|lock memory|VirtualLock|working set/i.test(this.log.join('\n'))) {
        this.noLock = true; // Windows wouldn't lock the memory: load normally instead
        return this.launch();
      }
      if (this.logger) this.logger.error('Local AI failed to start', err.message, this.log.slice(-8).join('\n'));
      this.failed = err.message;
      this.emit('progress', { state: 'failed', percent: 0, label: err.message });
      throw err;
    }
    this.endpoint = { baseUrl, apiKey, model: files.id, ctx };
    this.progress(100, 'Ready');
    this.emit('state', 'ready');
    this.touch();
    return this.endpoint;
  }

  /** Loading progress for the startup loader: never goes backwards within one load. */
  progress(percent, label) {
    if (percent < 100 && percent <= (this.lastPercent || 0)) return;
    this.lastPercent = percent < 100 ? percent : 0;
    this.lastLabel = label;
    this.emit('progress', { state: percent >= 100 ? 'ready' : 'loading', percent, label, elapsed: Date.now() - (this.loadStarted || Date.now()) });
  }

  /**
   * Reading Bigfoot's instructions and tools the first time (saved afterwards, so later starts
   * restore them in a second). Requests wait for it: they need the same reading.
   * @param {number|null} percent null when done
   */
  setPreparing(percent) {
    this.preparing = percent == null ? null : { percent: Math.max(0, Math.min(99, Math.round(percent))), since: (this.preparing && this.preparing.since) || Date.now() };
    this.emit('progress', this.status());
  }

  /** What the loader shows right now. */
  status() {
    if (this.endpoint && this.preparing) {
      return { state: 'preparing', percent: this.preparing.percent, label: 'Preparing for first use (one time)', elapsed: Date.now() - this.preparing.since };
    }
    if (this.endpoint) return { state: 'ready', percent: 100, label: 'Ready' };
    if (this.starting) return { state: 'loading', percent: this.lastPercent || 3, label: this.lastLabel || 'Starting', elapsed: Date.now() - (this.loadStarted || Date.now()) };
    if (this.failed) return { state: 'failed', percent: 0, label: this.failed };
    if (!this.manager.paths()) return { state: 'none', percent: 0, label: 'No model installed' };
    return { state: 'stopped', percent: 0, label: 'Not loaded' };
  }

  /** The server died on its own: bring it back, unless it keeps crashing. */
  recover(code) {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.logger) this.logger.error(`Local AI stopped unexpectedly (exit ${code})`, this.log.slice(-5).join('\n'));
    if (!this.keepLoaded || this.restarts.length >= MAX_RESTARTS) return;
    this.restarts.push(now);
    setTimeout(() => this.preload(), 2000);
  }

  /**
   * Wait while the model loads. A busy PC can take many minutes, and killing a load that is still
   * moving only starts it over from disk, so give up only when it stops making progress.
   */
  async waitHealthy(baseUrl, apiKey) {
    const started = Date.now();
    let lastProgress = Date.now();
    let seen = this.log.length;
    let lastLine = this.log[this.log.length - 1];
    while (Date.now() - started < MAX_LOAD_MS) {
      try {
        const res = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          if (this.logger) this.logger.info(`The local AI is ready (loaded in ${Math.round((Date.now() - started) / 1000)} s)`);
          return;
        }
      } catch { /* still loading */ }
      const line = this.log[this.log.length - 1];
      if (this.log.length !== seen || line !== lastLine) { seen = this.log.length; lastLine = line; lastProgress = Date.now(); }
      if (Date.now() - lastProgress > START_TIMEOUT_MS) break; // no sign of life for minutes
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new RuntimeError(lowMemory()
      ? 'The local AI couldn’t load: this PC is low on free memory. Close some apps (browser tabs use a lot) and try again.'
      : 'The local AI took too long to load. Try again, or choose a smaller model in Settings › Models.');
  }
}

function explainExit(code, log) {
  const text = log.join('\n');
  if (/out of memory|failed to allocate|ErrorOutOfDeviceMemory|cudaMalloc failed/i.test(text)) {
    return 'There isn’t enough free memory to load the local AI. Close some apps, or choose a smaller model in Settings › Models.';
  }
  if (/failed to load model|error loading model|invalid magic|failed to read/i.test(text)) {
    return 'The local AI model files look damaged. Pick a model in Settings › Models to download a fresh copy.';
  }
  if (/address already in use|bind/i.test(text)) return 'The local AI couldn’t open its port. Try again.';
  const last = log.filter((l) => /error|fail/i.test(l)).slice(-1)[0];
  return `The local AI stopped unexpectedly (exit code ${code})${last ? `: ${last.slice(0, 160)}` : ''}.`;
}

module.exports = { LocalRuntime, RuntimeError, explainExit, contextSize, tuningFor, threadCount };
