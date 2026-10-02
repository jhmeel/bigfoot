'use strict';
// Bigfoot's voice, on a worker thread so speaking never holds up the app: Kokoro 82M (Apache 2.0)
// with ONNX Runtime. Text becomes phonemes (eSpeak NG via phonemizer), phonemes become token ids,
// and the model turns them and a voice's style vector into 24 kHz audio. Text preparation follows
// kokoro-js (Apache 2.0) so it sounds the same.

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 24000;
const MAX_TOKENS = 510;
const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RUN = new RegExp(`(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

let model = null;

async function load() {
  if (model) return model;
  const ort = require('onnxruntime-node');
  const dir = workerData.dir;
  // Two threads: the AI model is busy on the others, and speech is short.
  const session = await ort.InferenceSession.create(path.join(dir, 'kokoro.onnx'), { intraOpNumThreads: 2, graphOptimizationLevel: 'all' });
  const tok = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8'));
  const { phonemize } = require('phonemizer');
  model = { ort, session, vocab: tok.model.vocab, phonemize, voices: new Map() };
  // The first run of a model is slow (it sets itself up): do it now, not on the first reply.
  await speak({ text: 'Okay.', voice: 'af_heart', speed: 1 }).catch(() => {});
  return model;
}

function style(m, voice, tokens) {
  if (!m.voices.has(voice)) {
    const file = path.join(workerData.dir, `${voice}.bin`);
    const b = fs.readFileSync(file);
    m.voices.set(voice, new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
  }
  const row = Math.min(Math.max(tokens - 2, 0), 509) * 256; // a style per sentence length
  return m.voices.get(voice).slice(row, row + 256);
}

/** Spoken forms for numbers, money and abbreviations, as kokoro-js writes them. */
function normalize(text) {
  const time = (t) => {
    if (t.includes('.')) return t;
    if (t.includes(':')) {
      const [h, m] = t.split(':').map(Number);
      return m === 0 ? `${h} o'clock` : m < 10 ? `${h} oh ${m}` : `${h} ${m}`;
    }
    const year = parseInt(t.slice(0, 4), 10);
    if (year < 1100 || year % 1000 < 10) return t;
    const head = t.slice(0, 2);
    const tail = parseInt(t.slice(2, 4), 10);
    const s = t.endsWith('s') ? 's' : '';
    if (year % 1000 >= 100 && year % 1000 <= 999) {
      if (tail === 0) return `${head} hundred${s}`;
      if (tail < 10) return `${head} oh ${tail}${s}`;
    }
    return `${head} ${tail}${s}`;
  };
  const money = (t) => {
    const unit = t[0] === '$' ? 'dollar' : 'pound';
    if (isNaN(Number(t.slice(1)))) return `${t.slice(1)} ${unit}s`;
    if (!t.includes('.')) return `${t.slice(1)} ${unit}${t.slice(1) === '1' ? '' : 's'}`;
    const [whole, part] = t.slice(1).split('.');
    const cents = parseInt(part.padEnd(2, '0'), 10);
    return `${whole} ${unit}${whole === '1' ? '' : 's'} and ${cents} ${t[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : (cents === 1 ? 'penny' : 'pence')}`;
  };
  const decimal = (t) => { const [a, b] = t.split('.'); return `${a} point ${b.split('').join(' ')}`; };
  return text
    .replace(/[‘’]/g, "'").replace(/[“”«»]/g, '"').replace(/\(/g, '«').replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ').replace(/ {2,}/g, ' ')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor').replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss').replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc').replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, time)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, money)
    .replace(/\d*\.\d+/g, decimal).replace(/(?<=\d)-(?=\d)/g, ' to ').replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S").replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-')).replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

async function phonemes(m, text, british) {
  const clean = normalize(text);
  const parts = [];
  let last = 0;
  for (const p of clean.matchAll(PUNCT_RUN)) {
    if (last < p.index) parts.push({ punct: false, text: clean.slice(last, p.index) });
    if (p[0].length) parts.push({ punct: true, text: p[0] });
    last = p.index + p[0].length;
  }
  if (last < clean.length) parts.push({ punct: false, text: clean.slice(last) });
  const lang = british ? 'en' : 'en-us';
  const joined = (await Promise.all(parts.map(async (p) => (p.punct ? p.text : (await m.phonemize(p.text, lang)).join(' '))))).join('');
  let out = joined.replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ').replace(/ʲ/g, 'j').replace(/r/g, 'ɹ')
    .replace(/x/g, 'k').replace(/ɬ/g, 'l').replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ').replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (!british) out = out.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return out.trim();
}

/** 16-bit mono WAV, what the audio engine plays. */
function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SAMPLE_RATE, 24); head.writeUInt32LE(SAMPLE_RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

async function speak({ text, voice, speed }) {
  const m = await load();
  const ph = await phonemes(m, text, voice.startsWith('b'));
  const ids = [0];
  for (const ch of ph) if (m.vocab[ch] !== undefined && ids.length < MAX_TOKENS + 1) ids.push(m.vocab[ch]);
  ids.push(0);
  if (ids.length <= 2) return null; // nothing to say
  const { ort, session } = m;
  const out = await session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    style: new ort.Tensor('float32', style(m, voice, ids.length), [1, 256]),
    speed: new ort.Tensor('float32', Float32Array.from([speed]), [1]),
  });
  return wav(out.waveform.data);
}

parentPort.on('message', async ({ id, cmd, args }) => {
  try {
    const result = cmd === 'load' ? (await load(), true) : await speak(args);
    parentPort.postMessage({ id, result }, result && result.buffer ? [result.buffer] : []);
  } catch (err) {
    parentPort.postMessage({ id, error: err.message || String(err) });
  }
});
