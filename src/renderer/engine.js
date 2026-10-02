'use strict';
// Hidden audio engine: microphone capture (16 kHz WAV) with level metering and voice-activity
// detection, speech playback, and the UI sounds.

(() => {
  const api = window.buddy;
  const TARGET_RATE = 16000;
  const SPEECH_RMS = 0.02;          // above this counts as speech
  const END_SILENCE_MS = 1300;      // after speech, this much quiet ends a wake-word request
  const NO_SPEECH_MS = 6000;        // give up if nobody speaks after the wake word
  const MAX_RECORD_MS = 30000;

  let ctx = null;
  const audioCtx = () => {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };

  // microphone
  let stream = null;
  let source = null;
  let processor = null;
  let sink = null;
  let recording = null; // { chunks, vad, startedAt, lastSpeechAt, heardSpeech, timer }
  let smoothed = 0;
  let lastLevelSent = 0;

  async function openMic() {
    if (stream) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw new Error('Microphone permission denied');
      if (err && err.name === 'NotFoundError') throw new Error('No microphone found. Plug one in and try again.');
      throw err;
    }
    const c = audioCtx();
    source = c.createMediaStreamSource(stream);
    processor = c.createScriptProcessor(4096, 1, 1);
    sink = c.createGain();
    sink.gain.value = 0; // keep the graph running without echoing the mic to the speakers
    processor.onaudioprocess = onAudio;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(c.destination);
  }

  function closeMic() {
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); }
    if (source) source.disconnect();
    if (sink) sink.disconnect();
    processor = source = sink = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    smoothed = 0;
    api.send('engine:level', 0);
  }

  function onAudio(e) {
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    smoothed = smoothed * 0.5 + rms * 0.5;
    const now = performance.now();
    if (now - lastLevelSent > 28) {
      lastLevelSent = now;
      api.send('engine:level', Math.min(1, smoothed));
    }
    if (!recording) return;
    recording.chunks.push(downsample(input, e.inputBuffer.sampleRate));
    if (rms > SPEECH_RMS) {
      recording.heardSpeech = true;
      recording.lastSpeechAt = now;
    }
    if (recording.vad && !recording.ended) {
      const quietFor = now - recording.lastSpeechAt;
      const elapsed = now - recording.startedAt;
      if ((recording.heardSpeech && quietFor > END_SILENCE_MS) || (!recording.heardSpeech && !recording.patient && elapsed > NO_SPEECH_MS)) {
        recording.ended = true;
        api.send('engine:vad', recording.heardSpeech ? 'silence' : 'no-speech');
      }
    }
  }

  function downsample(input, rate) {
    if (rate === TARGET_RATE) return Float32Array.from(input);
    const ratio = rate / TARGET_RATE;
    const out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
      // average the source samples that map onto this output sample (cheap low-pass)
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let acc = 0;
      for (let j = start; j < end; j++) acc += input[j];
      out[i] = acc / Math.max(1, end - start);
    }
    return out;
  }

  function encodeWav(chunks) {
    const length = chunks.reduce((n, c) => n + c.length, 0);
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    const str = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, TARGET_RATE, true); view.setUint32(28, TARGET_RATE * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, length * 2, true);
    let offset = 44;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
    }
    return buffer;
  }

  async function recordStart({ vad, patient }) {
    await openMic();
    const now = performance.now();
    recording = { chunks: [], vad: Boolean(vad), patient: Boolean(patient), startedAt: now, lastSpeechAt: now, heardSpeech: false, ended: false };
    const limit = () => {
      if (!recording || recording.ended) return;
      // Waiting patiently: drop the silence so far instead of ending, so memory stays flat.
      if (recording.patient && !recording.heardSpeech) {
        recording.chunks = [];
        recording.startedAt = performance.now();
        recording.timer = setTimeout(limit, MAX_RECORD_MS);
        return;
      }
      recording.ended = true;
      api.send('engine:vad', 'timeout');
    };
    recording.timer = setTimeout(limit, MAX_RECORD_MS);
    return true;
  }

  function recordStop() {
    if (!recording) { closeMic(); return null; }
    const r = recording;
    recording = null;
    clearTimeout(r.timer);
    closeMic();
    return { wav: encodeWav(r.chunks), heardSpeech: r.heardSpeech };
  }

  // speech
  let currentAudio = null;
  let finishSpeech = null;

  function stopAudio() {
    speechSynthesis.cancel();
    if (currentAudio) {
      currentAudio.pause();
      URL.revokeObjectURL(currentAudio.src);
      currentAudio = null;
    }
    if (finishSpeech) { finishSpeech(); finishSpeech = null; }
  }

  // Bigfoot speaks with a female voice unless the user picks another.
  const FEMALE_VOICE = /\b(zira|hazel|susan|aria|jenny|sonia|libby|michelle|ava|emma|clara|natasha|catherine|linda|heera|eva|elsa|hortense|julie|helena|laura|sabina|paulina|hedda|katja|irina|sarah|salli|joanna|kendra|kimberly|ivy|amy|nicole|olivia|female)\b/i;

  function voicesReady(timeoutMs = 6000) {
    return new Promise((resolve) => {
      const started = performance.now();
      const check = () => {
        const list = speechSynthesis.getVoices();
        if (list.length || performance.now() - started > timeoutMs) resolve(list);
        else setTimeout(check, 150);
      };
      check();
    });
  }

  async function speakSystem({ text, voice, rate }) {
    stopAudio();
    const voices = await voicesReady();
    if (!voices.length) throw new Error('No Windows voices are installed.');
    const female = (v) => FEMALE_VOICE.test(v.name);
    const en = (v) => /^en/i.test(v.lang);
    const chosen = voices.find((v) => v.name === voice)
      || voices.find((v) => female(v) && en(v) && /natural|online/i.test(v.name))
      || voices.find((v) => female(v) && en(v))
      || voices.find((v) => female(v))
      || voices.find((v) => v.default) || voices[0];
    // Sentence by sentence: very long utterances can stall on some Windows voices.
    const parts = String(text).match(/[^.!?]+[.!?]*\s*/g) || [String(text)];
    let stopped = false;
    for (const part of parts) {
      if (stopped || !part.trim()) continue;
      await new Promise((resolve, reject) => {
        const u = new SpeechSynthesisUtterance(part.trim());
        u.voice = chosen;
        u.rate = Math.max(0.5, Math.min(2, Number(rate) || 1));
        u.onend = () => { finishSpeech = null; resolve(); };
        u.onerror = (e) => {
          finishSpeech = null;
          if (e.error === 'interrupted' || e.error === 'canceled') { stopped = true; resolve(); } else reject(new Error(`Speech failed: ${e.error}`));
        };
        finishSpeech = () => { stopped = true; resolve(); };
        speechSynthesis.speak(u);
      });
    }
  }

  function play({ audio, type = 'audio/mpeg' }) {
    stopAudio();
    return new Promise((resolve, reject) => {
      const el = new Audio(URL.createObjectURL(new Blob([audio], { type })));
      currentAudio = el;
      finishSpeech = resolve;
      const cleanup = () => { URL.revokeObjectURL(el.src); if (currentAudio === el) currentAudio = null; finishSpeech = null; };
      el.onended = () => { cleanup(); resolve(); };
      el.onerror = () => { cleanup(); reject(new Error('The voice audio couldn’t be played.')); };
      el.play().catch((err) => { cleanup(); reject(err); });
    });
  }

  // outline drawing
  /** Draw the user's traced outline onto a screenshot so the model sees exactly what they marked. */
  async function markImage({ png, points }) {
    const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext('2d');
    g.drawImage(bitmap, 0, 0);
    const scale = Math.max(1, bitmap.width / 1000);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.strokeStyle = 'rgba(255, 255, 255, 0.9)'; // light halo keeps the line visible on dark content
    g.lineWidth = 5 * scale;
    g.stroke();
    g.strokeStyle = '#1f6bff';
    g.lineWidth = 3 * scale;
    g.stroke();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
  }

  /** Lay the user's drawing (a full-display transparent PNG) over a screenshot or a zoomed part of it. */
  async function composite({ png, overlay, crop }) {
    const [shot, ink] = await Promise.all([png, overlay].map((b) => createImageBitmap(new Blob([b], { type: 'image/png' }))));
    const canvas = new OffscreenCanvas(shot.width, shot.height);
    const g = canvas.getContext('2d');
    g.drawImage(shot, 0, 0);
    if (crop) {
      const sx = crop.x0 * ink.width;
      const sy = crop.y0 * ink.height;
      g.drawImage(ink, sx, sy, (crop.x1 - crop.x0) * ink.width, (crop.y1 - crop.y0) * ink.height, 0, 0, shot.width, shot.height);
    } else {
      g.drawImage(ink, 0, 0, shot.width, shot.height);
    }
    return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  }

  // UI sounds, synthesized
  function tone(c, { freq, start, dur, type = 'sine', gain = 0.12, to = null, lp = null }) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, start + dur * 0.9);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    let node = osc;
    if (lp) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lp;
      osc.connect(f);
      node = f;
    }
    node.connect(g).connect(c.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  const SOUNDS = {
    'listen-start': (c, t) => { tone(c, { freq: 587, start: t, dur: 0.11, gain: 0.09 }); tone(c, { freq: 880, start: t + 0.07, dur: 0.16, gain: 0.1 }); },
    'listen-stop': (c, t) => { tone(c, { freq: 880, start: t, dur: 0.1, gain: 0.08 }); tone(c, { freq: 587, start: t + 0.06, dur: 0.15, gain: 0.08 }); },
    done: (c, t) => {
      [659, 831, 988].forEach((f, i) => tone(c, { freq: f, start: t + i * 0.07, dur: 0.35, type: 'triangle', gain: 0.07 }));
      tone(c, { freq: 1319, start: t + 0.21, dur: 0.5, gain: 0.03 });
    },
    error: (c, t) => {
      tone(c, { freq: 392, start: t, dur: 0.14, type: 'triangle', gain: 0.11, lp: 1800 });
      tone(c, { freq: 294, start: t + 0.13, dur: 0.24, type: 'triangle', gain: 0.11, lp: 1800 });
    },
    attention: (c, t) => { tone(c, { freq: 1047, start: t, dur: 0.28, gain: 0.07 }); tone(c, { freq: 1568, start: t, dur: 0.18, gain: 0.025 }); },
  };

  // commands from the main process
  const COMMANDS = {
    'record-start': recordStart,
    'record-stop': async () => recordStop(),
    'monitor-start': async () => { await openMic(); return true; },
    'monitor-stop': async () => { if (!recording) closeMic(); return true; },
    'speak-system': speakSystem,
    'mark-image': markImage,
    composite,
    'list-voices': async () => (await voicesReady()).map((v) => ({ id: v.name, lang: v.lang, isDefault: v.default })),
    play,
    'stop-audio': async () => { stopAudio(); return true; },
    sound: async ({ name }) => {
      const c = audioCtx();
      if (SOUNDS[name]) SOUNDS[name](c, c.currentTime + 0.01);
      return true;
    },
  };

  api.on('engine:cmd', async ({ id, cmd, args }) => {
    try {
      const fn = COMMANDS[cmd];
      if (!fn) throw new Error(`Unknown engine command ${cmd}`);
      api.send('engine:reply', { id, result: await fn(args || {}) });
    } catch (err) {
      api.send('engine:reply', { id, error: { message: (err && err.message) || String(err) } });
    }
  });
  api.send('engine:ready');
})();
