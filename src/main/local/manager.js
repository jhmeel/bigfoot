'use strict';
// Downloads, verifies and installs the local AI. Network drops, going offline and app restarts
// resume from the bytes on disk; only unrecoverable problems end in "failed".

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const { downloadFile, sha256File, DownloadError } = require('./download');

const MAX_FAILURES = 12; // consecutive attempts without a new byte
const PROGRESS_EVERY_MS = 250;
const ONLINE_POLL_MS = 3000;
const SPEED_WINDOW_MS = 8000;

class LocalModelManager extends EventEmitter {
  constructor({ dir, settings, logger, isOnline = () => true, arch = process.arch, extract = extractZip, fetchImpl }) {
    super();
    Object.assign(this, { dir, settings, logger, isOnline, arch, extract, fetchImpl });
    this.stateFile = path.join(dir, 'state.json');
    this.job = null;
    this.control = null;
    this.wake = null; // cuts a retry wait short
    this.samples = [];
    this.lastEmit = 0;
    this.loadState();
  }

  runtimeDir() { return path.join(this.dir, 'runtime', catalog.RUNTIME_TAG); }
  modelDir(id) { return path.join(this.dir, 'models', id); }
  fileTarget(f, modelId) { return f.runtime ? path.join(this.dir, 'runtime', f.name) : path.join(this.modelDir(modelId), f.name); }

  /**
   * The installed model. Decided by the files on disk, not only the saved setting: after a reinstall
   * or reset settings the model is still there, and setup must not download it again.
   */
  installedId() {
    const id = this.settings.get('localModel');
    if (id && catalog.modelById(id) && this.complete(id)) return id;
    if (this.active()) return id && catalog.modelById(id) ? id : ''; // mid-download: files are partial
    const found = catalog.MODELS.find((m) => this.complete(m.id));
    if (found && found.id !== id) {
      if (this.logger) this.logger.info(`Found ${found.label} already on this PC; using it`);
      this.settings.update({ localModel: found.id });
    }
    return found ? found.id : '';
  }

  /** Every file of a model, at its exact size, and the runtime to run it. */
  complete(id) {
    const m = catalog.modelById(id);
    if (!m || !fs.existsSync(path.join(this.runtimeDir(), 'llama-server.exe'))) return false;
    return m.files.every((f) => {
      try { return fs.statSync(path.join(this.modelDir(id), f.name)).size === f.size; } catch { return false; }
    });
  }

  paths(id = this.installedId()) {
    const m = catalog.modelById(id);
    if (!m) return null;
    const server = path.join(this.runtimeDir(), 'llama-server.exe');
    const [model, mmproj] = m.files.map((f) => path.join(this.modelDir(id), f.name));
    if (![server, model, mmproj].every((p) => fs.existsSync(p))) return null;
    return { id, label: m.label, server, cwd: this.runtimeDir(), model, mmproj };
  }

  loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (s && catalog.modelById(s.modelId)) {
        this.job = { modelId: s.modelId, status: s.status === 'failed' ? 'failed' : s.pausedBy === 'user' ? 'paused' : 'queued', pausedBy: s.pausedBy || null, message: s.message || '' };
      }
    } catch { /* no job */ }
  }

  saveState() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!this.job) { fs.rmSync(this.stateFile, { force: true }); return; }
      const { modelId, status, pausedBy, message } = this.job;
      fs.writeFileSync(this.stateFile, JSON.stringify({ modelId, status, pausedBy, message }));
    } catch (err) {
      if (this.logger) this.logger.error('Couldn’t save download state', err.message);
    }
  }

  /**
   * A model that is no longer offered (2B) is removed and replaced by the recommended one.
   * @returns {Promise<string|null>} the model being downloaded instead, or null
   */
  async replaceRetired(recommend) {
    const id = this.settings.get('localModel');
    const leftovers = catalog.RETIRED.map((r) => this.modelDir(r)).filter((d) => fs.existsSync(d));
    if (!catalog.RETIRED.includes(id) && !leftovers.length) return null;
    for (const d of leftovers) await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {});
    for (const f of await fs.promises.readdir(path.join(this.dir, 'cache')).catch(() => [])) {
      if (catalog.RETIRED.some((r) => f.startsWith(`${r}-`))) await fs.promises.rm(path.join(this.dir, 'cache', f), { force: true }).catch(() => {});
    }
    if (!catalog.RETIRED.includes(id)) return null;
    this.settings.update({ localModel: '' });
    if (this.job && this.active()) return this.job.modelId;
    const pick = (await recommend()).pick;
    this.start(pick);
    return pick;
  }

  resumeOnStart() {
    if (this.job && this.job.status === 'queued') this.run();
    else this.emitProgress(true);
  }

  start(modelId) {
    if (!catalog.modelById(modelId)) throw new Error(`Unknown model ${modelId}`);
    if (this.job && this.job.modelId === modelId && this.active()) return this.snapshot();
    if (this.job && this.job.modelId !== modelId) this.stopAttempt();
    this.job = { modelId, status: 'queued', pausedBy: null, message: '' };
    this.saveState();
    this.run();
    return this.snapshot();
  }

  pause() {
    if (!this.job || !this.active()) return this.snapshot();
    this.stopAttempt();
    this.set({ status: 'paused', pausedBy: 'user', message: '' });
    this.saveState();
    return this.snapshot();
  }

  /** Resume a pause, retry a failure, or reconnect now. */
  resume() {
    if (!this.job) return this.snapshot();
    if (this.job.status === 'waiting' && this.wake) { this.wake(); return this.snapshot(); }
    if (this.active()) return this.snapshot();
    this.set({ status: 'queued', pausedBy: null, message: '' });
    this.saveState();
    this.run();
    return this.snapshot();
  }

  /** Deletes the partial download; an installed model is kept. */
  async cancel() {
    if (!this.job) return this.snapshot();
    const { modelId } = this.job;
    this.stopAttempt();
    this.job = null;
    this.saveState();
    if (modelId !== this.installedId()) await fs.promises.rm(this.modelDir(modelId), { recursive: true, force: true }).catch(() => {});
    await removeParts(path.join(this.dir, 'runtime'));
    this.emitProgress(true);
    return this.snapshot();
  }

  async remove() {
    const id = this.installedId();
    if (!id) return this.snapshot();
    this.emit('removing', id);
    this.settings.update({ localModel: '' });
    await fs.promises.rm(this.modelDir(id), { recursive: true, force: true }).catch(() => {});
    this.emitProgress(true);
    return this.snapshot();
  }

  active() {
    return Boolean(this.job) && ['queued', 'downloading', 'waiting', 'verifying', 'installing'].includes(this.job.status);
  }

  set(patch) {
    Object.assign(this.job, patch);
    this.emitProgress(true);
  }

  snapshot() {
    const installed = this.installedId();
    const installedModel = catalog.modelById(installed);
    const base = { installed, installedLabel: installedModel ? installedModel.label : '', runtime: catalog.RUNTIME_TAG };
    if (!this.job) return { ...base, status: installed ? 'ready' : 'none' };
    const m = catalog.modelById(this.job.modelId);
    const { bytesDone = 0, bytesTotal = catalog.downloadBytes(m.id, this.arch) } = this.job;
    const speed = this.speed();
    return {
      ...base,
      status: this.job.status,
      modelId: m.id,
      label: m.label,
      pausedBy: this.job.pausedBy,
      message: this.job.message || '',
      bytesDone,
      bytesTotal,
      fraction: bytesTotal ? Math.min(1, bytesDone / bytesTotal) : 0,
      verifyFraction: this.job.verifyFraction || 0,
      speed: this.job.status === 'downloading' ? speed : 0,
      etaSec: this.job.status === 'downloading' && speed > 0 ? Math.round((bytesTotal - bytesDone) / speed) : null,
      retryAt: this.job.retryAt || null,
      file: this.job.file || '',
    };
  }

  speed() {
    const now = Date.now();
    this.samples = this.samples.filter((s) => now - s.t < SPEED_WINDOW_MS);
    if (this.samples.length < 2) return 0;
    const bytes = this.samples.reduce((n, s) => n + s.n, 0) - this.samples[0].n;
    const secs = (now - this.samples[0].t) / 1000;
    return secs > 0.5 ? bytes / secs : 0;
  }

  emitProgress(force = false) {
    const wait = PROGRESS_EVERY_MS - (Date.now() - this.lastEmit);
    if (!force && wait > 0) {
      if (!this.trailing) this.trailing = setTimeout(() => this.emitProgress(true), wait);
      return;
    }
    clearTimeout(this.trailing);
    this.trailing = null;
    this.lastEmit = Date.now();
    this.emit('progress', this.snapshot());
  }

  stopAttempt() {
    if (this.control) this.control.abort();
    this.control = null;
    if (this.wake) this.wake();
  }

  async run() {
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    try {
      do {
        this.rerun = false;
        const job = this.job;
        if (!job || job.status !== 'queued') break;
        await this.runJob(job);
      } while (this.rerun);
    } finally {
      this.running = false;
    }
  }

  async runJob(job) {
    const control = new AbortController();
    this.control = control;
    const { signal } = control;
    const files = catalog.filesFor(job.modelId, this.arch);
    const total = files.reduce((n, f) => n + f.size, 0);
    job.bytesTotal = total;
    this.samples = [];
    try {
      await fs.promises.mkdir(this.modelDir(job.modelId), { recursive: true });
      await this.checkDisk(files, job.modelId);
      for (const [i, f] of files.entries()) {
        if (signal.aborted) return;
        const doneBefore = await this.completedBytes(files.slice(0, i), job.modelId);
        if (await this.isInstalled(f, job.modelId)) { job.bytesDone = doneBefore + f.size; continue; }
        job.file = f.runtime ? 'AI runtime' : f.name;
        await this.fetchVerified(job, f, doneBefore, signal);
        if (signal.aborted) return;
        if (f.runtime) await this.installRuntime(job, f, signal, this.runtimeDir(), 'llama-server.exe');
      }
      if (signal.aborted) return;
      await this.finish(job);
    } catch (err) {
      if (signal.aborted || (err && err.name === 'AbortError')) return;
      if (this.logger) this.logger.error('Local AI download failed', err.message);
      if (this.job === job) {
        this.set({ status: 'failed', message: friendly(err), retryAt: null });
        this.saveState();
      }
    } finally {
      if (this.control === control) this.control = null;
    }
  }

  async completedBytes(files, modelId) {
    let n = 0;
    for (const f of files) if (await this.isInstalled(f, modelId)) n += f.size;
    return n;
  }

  async isInstalled(f, modelId) {
    if (f.runtime) return fs.existsSync(path.join(this.runtimeDir(), 'llama-server.exe'));
    try { return (await fs.promises.stat(this.fileTarget(f, modelId))).size === f.size; } catch { return false; }
  }

  async checkDisk(files, modelId) {
    let need = 0;
    for (const f of files) {
      if (await this.isInstalled(f, modelId)) continue;
      let have = 0;
      try { have = (await fs.promises.stat(this.fileTarget(f, modelId) + '.part')).size; } catch { /* none yet */ }
      need += f.size - have + (f.runtime ? f.size * 3 : 0); // room to unzip
    }
    try {
      const s = await fs.promises.statfs(this.dir);
      const free = s.bavail * s.bsize;
      if (free < need * 1.03 + 200 * 1024 * 1024) {
        throw new DownloadError(`Not enough disk space: ${gb(need)} more is needed and ${gb(free)} is free. Free up some space, then retry.`, { retryable: false, code: 'disk' });
      }
    } catch (err) {
      if (err instanceof DownloadError) throw err;
    }
  }

  async fetchVerified(job, f, doneBefore, signal) {
    const target = this.fileTarget(f, job.modelId);
    const part = target + '.part';
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    for (let hashAttempt = 0; ; hashAttempt++) {
      await this.downloadWithRetries(job, f, part, doneBefore, signal);
      if (signal.aborted) return;
      this.set({ status: 'verifying', verifyFraction: 0, message: '' });
      let read = 0;
      const hash = await sha256File(part, {
        signal,
        onBytes: (n) => { read += n; job.verifyFraction = read / f.size; this.emitProgress(); },
      });
      if (hash === f.sha256) break;
      await fs.promises.rm(part, { force: true });
      if (this.logger) this.logger.error(`Checksum mismatch for ${f.name}: got ${hash}`);
      if (hashAttempt >= 1) throw new DownloadError(`${f.name} was corrupted twice in a row. Check your connection, then retry.`, { retryable: false, code: 'hash' });
      this.set({ message: `${f.name} didn’t pass verification, downloading it again…` });
    }
    await fs.promises.rename(part, target);
    job.bytesDone = doneBefore + f.size;
  }

  async downloadWithRetries(job, f, part, doneBefore, signal) {
    let failures = 0;
    for (;;) {
      if (signal.aborted) return;
      if (!this.isOnline()) {
        this.set({ status: 'waiting', pausedBy: 'network', message: 'You’re offline. The download will continue when you’re back online.', retryAt: null });
        await this.waitForOnline(signal);
        continue;
      }
      let partSize = 0;
      try { partSize = (await fs.promises.stat(part)).size; } catch { /* new file */ }
      job.bytesDone = doneBefore + partSize;
      this.set({ status: 'downloading', pausedBy: null, message: '', retryAt: null });
      let gained = 0;
      try {
        await downloadFile({
          url: f.url, dest: part, size: f.size, signal, fetchImpl: this.fetchImpl,
          onBytes: (n, written) => {
            gained += n;
            job.bytesDone = doneBefore + written;
            this.samples.push({ t: Date.now(), n });
            this.emitProgress();
          },
        });
        return;
      } catch (err) {
        if (signal.aborted) return;
        if (!(err instanceof DownloadError) || !err.retryable) throw err;
        failures = gained > 0 ? 1 : failures + 1;
        if (failures >= MAX_FAILURES) throw new DownloadError('The download kept failing to connect. Check your internet connection, then retry.', { retryable: false, code: 'network' });
        const delay = Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
        this.set({ status: 'waiting', pausedBy: 'network', message: `${err.message} Reconnecting…`, retryAt: Date.now() + delay });
        await this.sleep(delay, signal);
      }
    }
  }

  async installRuntime(job, f, signal, dest, exe) {
    this.set({ status: 'installing', message: '' });
    const zip = this.fileTarget(f, job.modelId);
    const tmp = `${dest}.tmp`;
    await fs.promises.rm(tmp, { recursive: true, force: true });
    await fs.promises.mkdir(tmp, { recursive: true });
    await this.extract(zip, tmp);
    if (signal.aborted) return;
    const server = await findFile(tmp, exe);
    if (!server) throw new DownloadError(`The downloaded package is missing ${exe}. Retry to download it again.`, { retryable: false, code: 'runtime' });
    await fs.promises.rm(dest, { recursive: true, force: true });
    await fs.promises.rename(path.dirname(server), dest).catch(() => fs.promises.rename(tmp, dest));
    await fs.promises.rm(tmp, { recursive: true, force: true });
    await fs.promises.rm(zip, { force: true });
  }

  async finish(job) {
    this.set({ status: 'installing', message: '' });
    const previous = this.installedId();
    this.settings.update({ localModel: job.modelId });
    if (previous && previous !== job.modelId) {
      this.emit('removing', previous); // the runtime stops the old model: Windows can't delete files in use
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await fs.promises.rm(this.modelDir(previous), { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
    for (const entry of await fs.promises.readdir(path.join(this.dir, 'runtime')).catch(() => [])) {
      if (entry !== catalog.RUNTIME_TAG) await fs.promises.rm(path.join(this.dir, 'runtime', entry), { recursive: true, force: true }).catch(() => {});
    }
    this.job = null;
    this.saveState();
    this.emitProgress(true);
    this.emit('installed', job.modelId);
  }

  sleep(ms, signal) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.wake = null; signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      this.wake = done;
      signal.addEventListener('abort', done, { once: true });
    });
  }

  async waitForOnline(signal) {
    while (!signal.aborted && !this.isOnline()) await this.sleep(ONLINE_POLL_MS, signal);
  }
}

function gb(bytes) { return `${(bytes / catalog.GB).toFixed(1)} GB`; }

function friendly(err) {
  if (err instanceof DownloadError) {
    if (err.status === 404) return 'The download server couldn’t find the file. Update Bigfoot, then retry.';
    if (err.status === 401 || err.status === 403) return 'The download server refused the request. Retry in a few minutes.';
    return err.message;
  }
  if (err && err.code === 'ENOSPC') return 'Your disk is full. Free up some space, then retry.';
  if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) return 'A file is in use by another program. Close it, then retry.';
  return (err && err.message) || 'The download failed.';
}

async function findFile(dir, name) {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return p;
    if (entry.isDirectory()) {
      const found = await findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

async function removeParts(dir) {
  for (const entry of await fs.promises.readdir(dir).catch(() => [])) {
    if (entry.endsWith('.part')) await fs.promises.rm(path.join(dir, entry), { force: true }).catch(() => {});
  }
}

/** Windows' own tar, with PowerShell as a fallback. */
function extractZip(zip, dest) {
  const run = (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 180000 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
  });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return run(tar, ['-xf', zip, '-C', dest]).catch(() => run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
  ]));
}

module.exports = { LocalModelManager, extractZip, friendly };
