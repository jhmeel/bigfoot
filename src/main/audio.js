'use strict';
// Talks to the hidden audio engine window: recording, UI sounds, and speech with fallbacks.

const { ipcMain } = require('electron');
const { EventEmitter } = require('events');
const { Kokoro } = require('./kokoro');

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
    this.kokoro = new Kokoro(logger); // Bigfoot's own voice, on a worker thread

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

  /** Start making a sentence's audio now (Bigfoot's voice), so it's ready by the time it's its turn. */
  prepare(text, voice = null) {
    if (this.settings.get('ttsProvider') !== 'kokoro') return null;
    const p = this.kokoro.say(text, voice || this.settings.get('voice'), this.settings.get('speechRate'));
    p.catch(() => {}); // reported when it's played
    return p;
  }

  /**
   * "On it.", ready-made in the chosen voice, so a spoken request is answered at once while the AI
   * works. It leaves the reply's speech alone: the reply's first words simply follow it.
   */
  acknowledge() {
    if (!this.settings.get('speakResponses') || this.settings.get('ttsProvider') !== 'kokoro') return;
    const file = require('./kokoro').ackFile(this.settings.get('voice'), this.settings.get('speechRate'));
    if (!file) return;
    try {
      this.call('play', { audio: require('fs').readFileSync(file), type: 'audio/wav' }, 10000).catch(() => {});
    } catch { /* not important */ }
  }

  /** Play a ready-made recording (a voice preview). */
  async playFile(file) {
    this.stopSpeaking();
    this.speaking = true;
    try {
      await this.call('play', { audio: require('fs').readFileSync(file), type: 'audio/wav' }, 60000);
      return 'bigfoot';
    } catch (err) {
      this.logger.error('Couldn’t play the voice preview:', err.message);
      return 'none';
    } finally {
      this.speaking = false;
    }
  }

  /** Load Bigfoot's voice ahead of the first reply. */
  warmVoice() {
    if (this.settings.get('ttsProvider') === 'kokoro' && this.settings.get('speakResponses')) this.kokoro.warm();
  }

  /**
   * Speak a reply in Bigfoot's voice; if that fails, the Windows voice, then silence. The reply is
   * always typed out on screen as well, so nothing is lost.
   * Resolves to the voice actually used: 'bigfoot' | 'system' | 'none'.
   */
  async speak(text, { force = false, prepared = null, voice = null } = {}) {
    if (!text || (!force && !this.settings.get('speakResponses'))) return 'none';
    const rate = this.settings.get('speechRate');
    this.speaking = true;
    this.said = [...(this.said || []).slice(-20), { text, at: Date.now() }];
    try {
      // Several sentences or a long one: all parts start being made now, in order, and each
      // plays as soon as it's ready, so speech starts after the first short part.
      const parts = prepared ? [text] : sentences(String(text), true).flatMap((p) => clauses(p));
      const made = prepared ? [prepared] : parts.map((p) => this.prepare(p, voice));
      if (made.length && made.every(Boolean)) {
        try {
          let any = false;
          for (const next of made) {
            const audio = await next;
            if (!this.speaking) return 'none';
            if (!audio) continue; // nothing pronounceable
            await this.call('play', { audio, type: 'audio/wav' }, 120000);
            any = true;
          }
          return any ? 'bigfoot' : 'none';
        } catch (err) {
          if (!this.speaking) return 'none';
          this.logger.error('Bigfoot’s voice failed, using the Windows voice:', err.message);
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

  // speaking a reply as it's written
  /** Start a reply that arrives in pieces. */
  beginStream() {
    this.stream = { heard: new Set(), queue: Promise.resolve('none'), used: 'none' };
  }

  /**
   * The reply so far: speak every sentence that's now complete and not spoken yet, and the finished
   * phrases of the sentence still being written ("I opened Chrome," can be said already).
   */
  feedStream(text) {
    if (!this.stream || !this.settings.get('speakResponses')) return;
    const { done, rest } = split(String(text), false);
    this.say(done, true);
    const phrases = clauses(rest, done.length ? 24 : 4);
    phrases.pop(); // may still grow
    this.say(phrases, !done.length);
  }

  /** The whole reply: speak what's left. Resolves when everything has been said, to the voice used. */
  finishStream(text) {
    const s = this.stream;
    if (!s) return this.speak(text);
    if (this.settings.get('speakResponses')) this.say(sentences(String(text), true), true);
    return s.queue.then(() => (this.stream === s ? s.used : 'none'));
  }

  /**
   * Each phrase is spoken once, even if the text around it changes between the streamed version
   * and the final reply (a removed [POINT] tag, different spacing, a message that starts over).
   */
  say(list, startsReply = false) {
    const s = this.stream;
    list.forEach((sentence, i) => {
      // The reply's opening ("Sure,", "Okay,") is said on its own: it's ready in a moment.
      for (const part of clauses(sentence, startsReply && i === 0 ? 4 : 24)) {
        const key = part.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        if (!key || s.heard.has(key)) continue;
        s.heard.add(key);
        this.enqueue(s, part);
      }
    });
  }

  enqueue(s, sentence) {
    s.pending = (s.pending || 0) + 1;
    // Made right away and in order, so the next part is ready while this one plays.
    const prepared = this.prepare(sentence.trim());
    s.queue = s.queue.then(async () => {
      try {
        if (this.stream !== s) return 'none';
        const used = await this.speak(sentence.trim(), { prepared });
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
  return split(text, complete).done;
}

/** Sentences that are complete, and the text after them (the sentence still being written). */
function split(text, complete) {
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
  return { done: out, rest: complete ? '' : rest };
}

/**
 * A sentence in phrases, split after a comma, semicolon, colon or dash once a phrase has a few words:
 * the first phrase can be spoken while the rest is still being written or made. A phrase depends only
 * on the text before it, so a sentence splits the same way while it grows and once it's complete.
 */
function clauses(sentence, min = 24) {
  const text = String(sentence).trim();
  if (!text) return [];
  const out = [];
  let cur = '';
  for (const piece of text.split(/(?<=[,;:—])\s+/)) {
    cur = cur ? `${cur} ${piece}` : piece;
    if (cur.length >= min && /[,;:—]$/.test(cur)) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { AudioService, sentences, clauses };
