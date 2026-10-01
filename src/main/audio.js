'use strict';
// Talks to the hidden audio engine window: recording, UI sounds, and speech with fallbacks.

const { ipcMain } = require('electron');
const { EventEmitter } = require('events');
const voice = require('./voice');

class AudioService extends EventEmitter {
  constructor({ windows, settings, logger }) {
    super();
    this.windows = windows;
    this.settings = settings;
    this.logger = logger;
    this.waiters = new Map();
    this.seq = 0;
    this.speaking = false;
    this.stream = null;

    ipcMain.on('engine:reply', (_e, { id, result, error }) => {
      const w = this.waiters.get(id);
      if (!w) return;
      this.waiters.delete(id);
      clearTimeout(w.timer);
      if (error) w.reject(new Error(error.message || String(error)));
      else w.resolve(result);
    });
    ipcMain.on('engine:level', (_e, level) => this.emit('level', level));
    ipcMain.on('engine:vad', (_e, reason) => this.emit('vad', reason));
    // Commands sent before the engine page has loaded would be dropped, so hold them until it says so.
    this.resetReady();
    ipcMain.on('engine:ready', (e) => {
      if (this.windows.engine && e.sender === this.windows.engine.webContents) this.markReady();
    });
  }

  resetReady() {
    this.ready = new Promise((resolve) => { this.markReady = resolve; });
  }

  async call(cmd, args = {}, timeoutMs = 120000) {
    const loaded = await Promise.race([this.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
    const engine = this.windows.engine;
    if (!loaded || !engine || engine.isDestroyed()) throw new Error('The audio engine isn’t running.');
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`The audio engine didn’t respond (${cmd}).`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      engine.webContents.send('engine:cmd', { id, cmd, args });
    });
  }

  failAll(reason) {
    this.resetReady(); // the engine is being recreated; wait for the new one
    for (const [id, w] of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
      this.waiters.delete(id);
    }
  }

  sound(name) {
    if (this.settings.get('soundEffects')) this.call('sound', { name }, 5000).catch(() => {});
  }

  /** vad: stop by itself after the speaker goes quiet. patient: wait for speech as long as it takes (Talk mode). */
  startRecording({ vad = false, patient = false } = {}) { return this.call('record-start', { vad, patient }, 8000); }

  /** Resolves to { wav: ArrayBuffer, heardSpeech: boolean } or null. */
  stopRecording() { return this.call('record-stop', {}, 10000); }

  monitor(on) { return this.call(on ? 'monitor-start' : 'monitor-stop', {}, 8000); }

  /**
   * Speak a reply. Cloud voice falls back to the Windows voice, which falls back to silence;
   * the reply is always typed out on screen as well, so nothing is lost.
   * Resolves to the voice actually used: 'cloud' | 'system' | 'none'.
   */
  async speak(text, { force = false } = {}) {
    if (!text || (!force && !this.settings.get('speakResponses'))) return 'none';
    const provider = this.settings.get('ttsProvider');
    const rate = this.settings.get('speechRate');
    this.speaking = true;
    this.said = [...(this.said || []).slice(-20), { text, at: Date.now() }];
    try {
      if (provider !== 'system') {
        try {
          const key = this.settings.secret(provider === 'openai' ? 'openaiKey' : 'elevenlabsKey');
          const voiceId = provider === 'openai' ? this.settings.get('openaiVoice') : this.settings.get('elevenlabsVoice');
          const audio = await voice.synthesize({ provider, key, voice: voiceId, text, speed: rate });
          if (!this.speaking) return 'none';
          await this.call('play', { audio });
          return 'cloud';
        } catch (err) {
          if (!this.speaking) return 'none';
          this.logger.error('Cloud voice failed, using the Windows voice:', err.message);
          this.emit('fallback', err);
        }
      }
      try {
        await this.call('speak-system', { text, voice: this.settings.get('systemVoice'), rate });
        return 'system';
      } catch (err) {
        this.logger.error('Windows voice failed, reply is shown as text only:', err.message);
        return 'none';
      }
    } finally {
      this.speaking = false;
    }
  }

  stopSpeaking() {
    this.speaking = false;
    this.stream = null; // drops sentences still waiting to be spoken
    this.call('stop-audio', {}, 3000).catch(() => {});
  }

  // ---------------------------------------------------------------- speaking a reply as it's written
  /** Start a reply that arrives in pieces. */
  beginStream() {
    this.stream = { heard: new Set(), queue: Promise.resolve('none'), used: 'none' };
  }

  /** The reply so far: speak every sentence that's now complete and not spoken yet. */
  feedStream(text) {
    if (!this.stream || !this.settings.get('speakResponses')) return;
    this.say(sentences(text, false));
  }

  /** The whole reply: speak what's left. Resolves when everything has been said, to the voice used. */
  finishStream(text) {
    const s = this.stream;
    if (!s) return this.speak(text);
    if (this.settings.get('speakResponses')) this.say(sentences(String(text), true));
    return s.queue.then(() => (this.stream === s ? s.used : 'none'));
  }

  /**
   * Each sentence is spoken once, even if the text around it changes between the streamed version
   * and the final reply (a removed [POINT] tag, different spacing, a message that starts over).
   */
  say(list) {
    const s = this.stream;
    for (const sentence of list) {
      const key = sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      if (!key || s.heard.has(key)) continue;
      s.heard.add(key);
      this.enqueue(s, sentence);
    }
  }

  enqueue(s, sentence) {
    s.pending = (s.pending || 0) + 1;
    s.queue = s.queue.then(async () => {
      try {
        if (this.stream !== s) return 'none';
        const used = await this.speak(sentence.trim());
        if (used !== 'none') s.used = used;
        return used;
      } finally {
        s.pending--;
      }
    });
  }

  /** Still talking, or has sentences waiting to be said. Talk mode must not listen meanwhile. */
  isBusy() {
    return this.speaking || Boolean(this.stream && this.stream.pending > 0);
  }

  /**
   * Did the microphone just pick up Bigfoot's own voice? True when most of the words heard were
   * in something it said in the last half minute.
   */
  heardItself(text) {
    const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
    const heard = words(text);
    if (!heard.length) return false;
    const now = Date.now();
    this.said = (this.said || []).filter((x) => now - x.at < 30000);
    const recent = new Set(this.said.flatMap((x) => words(x.text)));
    const known = heard.filter((w) => recent.has(w)).length;
    return heard.length >= 2 ? known / heard.length >= 0.75 : false;
  }
}

/**
 * Split text into sentences. With complete=false the last piece is left out unless it clearly ends
 * (". " etc.), because it may still be growing; "3.5" or "e.g." mid-number isn't an ending.
 */
function sentences(text, complete) {
  const out = [];
  const re = /[\s\S]*?(?:[.!?…]+(?=\s|$)|\n+)/g;
  let m;
  let end = 0;
  while ((m = re.exec(text)) && m[0]) {
    if (!complete && m.index + m[0].length === text.length && !/\n$/.test(m[0])) break; // may still grow
    if (m[0].trim()) out.push(m[0].trim());
    end = m.index + m[0].length;
  }
  const rest = text.slice(end).trim();
  if (complete && rest) out.push(rest);
  return out;
}

module.exports = { AudioService, sentences };
