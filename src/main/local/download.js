'use strict';
// Resumable download (HTTP Range into a .part file) and SHA-256 verification.

const crypto = require('crypto');
const fs = require('fs');

const STALL_MS = 45000;

class DownloadError extends Error {
  constructor(message, { retryable = true, status = 0, code = '' } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
    this.code = code;
  }
}

async function sizeOf(file) {
  try { return (await fs.promises.stat(file)).size; } catch { return 0; }
}

async function downloadFile({ url, dest, size, signal, onBytes = () => {}, stallMs = STALL_MS, fetchImpl = fetch }) {
  let start = await sizeOf(dest);
  if (start > size) { await fs.promises.truncate(dest, 0); start = 0; }
  if (start === size) return;

  const stall = new AbortController();
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stall.abort(), stallMs);
  };
  const both = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;

  let res;
  armStall();
  try {
    res = await fetchImpl(url, {
      headers: start > 0 ? { Range: `bytes=${start}-` } : {},
      signal: both,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(stallTimer);
    if (signal && signal.aborted) throw err;
    throw new DownloadError(stall.signal.aborted ? 'The connection stalled.' : 'Couldn’t reach the download server.', { code: 'network' });
  }

  if (res.status === 416) {
    clearTimeout(stallTimer);
    await drain(res);
    if (start === size) return;
    await fs.promises.truncate(dest, 0);
    throw new DownloadError('The partial file didn’t match the server. Starting that file again.', { code: 'range' });
  }
  if (!res.ok) {
    clearTimeout(stallTimer);
    await drain(res);
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new DownloadError(`The download server returned ${res.status}.`, { retryable, status: res.status, code: 'http' });
  }

  let append = false;
  if (start > 0 && res.status === 206) {
    const m = /bytes\s+(\d+)-/i.exec(res.headers.get('content-range') || '');
    append = Boolean(m && Number(m[1]) === start);
  }
  if (!append) start = 0; // server ignored Range

  const fh = await fs.promises.open(dest, append ? 'a' : 'w');
  let written = start;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armStall();
      await fh.write(value);
      written += value.length;
      onBytes(value.length, written);
      if (written > size) throw new DownloadError('The server sent more data than expected.', { retryable: false, code: 'size' });
    }
  } catch (err) {
    if (signal && signal.aborted) throw err;
    if (err instanceof DownloadError) throw err;
    if (err && err.code === 'ENOSPC') throw new DownloadError('Your disk is full. Free up some space, then retry.', { retryable: false, code: 'disk' });
    throw new DownloadError(stall.signal.aborted ? 'The connection stalled.' : 'The connection dropped.', { code: 'network' });
  } finally {
    clearTimeout(stallTimer);
    await fh.close();
  }
  if (written < size) throw new DownloadError('The connection closed early.', { code: 'network' });
}

async function drain(res) {
  try { await res.arrayBuffer(); } catch { /* ignore */ }
}

function sha256File(file, { onBytes = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    const abort = () => { stream.destroy(); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    stream.on('data', (chunk) => { hash.update(chunk); onBytes(chunk.length); });
    stream.on('error', reject);
    stream.on('end', () => {
      if (signal) signal.removeEventListener('abort', abort);
      resolve(hash.digest('hex'));
    });
  });
}

module.exports = { downloadFile, sha256File, DownloadError, STALL_MS };
