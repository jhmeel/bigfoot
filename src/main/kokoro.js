'use strict';
// Bigfoot's built-in voice (Kokoro, see ./kokoro-worker.js). Sentences are made one after another on
// a worker thread, so the next one is ready while the current one plays.

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

let app = null;
try { ({ app } = require('electron')); } catch { /* tests */ }

/** The voices offered: Kokoro's makers rate Heart and Bella their best, then Emma; Michael and Fenrir lead the male voices. */
const VOICES = [
  { id: 'af_heart', name: 'Heart', gender: 'female', note: 'Warm and natural' },
  { id: 'af_bella', name: 'Bella', gender: 'female', note: 'Bright and lively' },
  { id: 'bf_emma', name: 'Emma', gender: 'female', note: 'British, calm' },
  { id: 'am_michael', name: 'Michael', gender: 'male', note: 'Clear and friendly' },
  { id: 'am_fenrir', name: 'Fenrir', gender: 'male', note: 'Deep and steady' },
];
const DEFAULT_VOICE = 'af_heart';

// What a voice says when previewed. Made ahead of time for the default name (vendor/voice/previews),
// so the play button sounds at once.
const PREVIEW_NAME = 'Bigfoot';
const previewText = (name) => `Hi! I’m ${name}. Just say hey ${name}, and tell me what to do.`;

/** A short "On it." in this voice, ready-made, played the moment a request goes to the AI. */
const ACK_TEXT = 'On it.';
function ackFile(voice, speed) {
  if (Math.abs(Number(speed) - 1) > 0.01) return null;
  const file = path.join(voiceDir(), 'previews', `ack-${voice}.wav`);
  return fs.existsSync(file) ? file : null;
}

/** The ready-made preview for this voice, if the name and speed match it. */
function previewFile(voice, name, speed) {
  if (name !== PREVIEW_NAME || Math.abs(Number(speed) - 1) > 0.01) return null;
  const file = path.join(voiceDir(), 'previews', `${voice}.wav`);
  return fs.existsSync(file) ? file : null;
}

function voiceDir() {
  return app && app.isPackaged ? path.join(process.resourcesPath, 'voice') : path.join(__dirname, '..', '..', 'vendor', 'voice');
}

function available() {
  return fs.existsSync(path.join(voiceDir(), 'kokoro.onnx'));
}

class Kokoro {
  constructor(logger = null) {
    this.logger = logger;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    if (this.worker) return this.worker;
    const w = new Worker(path.join(__dirname, 'kokoro-worker.js'), { workerData: { dir: voiceDir() } });
    w.on('message', ({ id, result, error }) => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
      if (!this.pending.size) w.unref(); // an idle voice doesn't keep the app running
    });
    const fail = (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      if (this.worker === w) this.worker = null;
    };
    w.on('error', fail);
    w.on('exit', (code) => fail(new Error(`The voice stopped (${code})`)));
    w.unref();
    this.worker = w;
    return w;
  }

  call(cmd, args) {
    const w = this.start();
    const id = this.nextId++;
    w.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, cmd, args });
    });
  }

  /** Load the voice ahead of the first reply (a few seconds). */
  warm() {
    if (!available()) return Promise.resolve(false);
    return this.call('load').catch((err) => { if (this.logger) this.logger.error('The voice couldn’t load', err.message); return false; });
  }

  /** @returns {Promise<Buffer|null>} WAV audio, or null if there was nothing to say */
  async say(text, voice = DEFAULT_VOICE, speed = 1) {
    if (!available()) throw new Error('Bigfoot’s voice isn’t installed');
    const id = VOICES.some((v) => v.id === voice) ? voice : DEFAULT_VOICE;
    const out = await this.call('speak', { text: String(text).slice(0, 600), voice: id, speed: Math.max(0.7, Math.min(1.4, Number(speed) || 1)) });
    return out ? Buffer.from(out.buffer, out.byteOffset, out.byteLength) : null;
  }

  stop() {
    if (this.worker) this.worker.terminate().catch(() => {});
    this.worker = null;
  }
}

module.exports = { Kokoro, VOICES, DEFAULT_VOICE, available, previewText, previewFile, PREVIEW_NAME, ackFile, ACK_TEXT };
