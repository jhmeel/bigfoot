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
    this.call('stop-audio', {}, 3000).catch(() => {});
  }
}

module.exports = { AudioService };
