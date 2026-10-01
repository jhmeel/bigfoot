'use strict';
// Reads handwritten math from a picture: Pix2Text MFR 1.5 (MIT licence, a TrOCR model trained on
// handwritten and printed formulas), shipped inside the app and run on the CPU with ONNX Runtime.
// About a second per line, where the vision model takes a minute or two on a PC without a
// graphics card, and it tells 2x from 24 and x from × far better than Windows' recognizers.
// The picture arrives as 384×384 RGBA pixels drawn by the math tool; out comes LaTeX.

const fs = require('fs');
const path = require('path');

const SIZE = 384;
const BOS = 1;
const EOS = 2;
const MAX_TOKENS = 160;

let app = null;
try { ({ app } = require('electron')); } catch { /* tests */ }

function modelDir() {
  return app && app.isPackaged ? path.join(process.resourcesPath, 'math') : path.join(__dirname, '..', '..', 'vendor', 'math');
}

let loading = null;

/** The two ONNX sessions and the tokenizer's vocabulary, loaded once. */
function load() {
  if (!loading) {
    loading = (async () => {
      const dir = modelDir();
      const ort = require('onnxruntime-node');
      const opts = { intraOpNumThreads: 4, graphOptimizationLevel: 'all' };
      const [encoder, decoder] = await Promise.all([
        ort.InferenceSession.create(path.join(dir, 'encoder_model.onnx'), opts),
        ort.InferenceSession.create(path.join(dir, 'decoder_model.onnx'), opts),
      ]);
      const vocab = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')).model.vocab;
      const tokens = [];
      for (const [piece, id] of Object.entries(vocab)) tokens[id] = piece;
      return { ort, encoder, decoder, tokens };
    })();
    loading.catch(() => { loading = null; }); // try again next time
  }
  return loading;
}

function available() {
  return fs.existsSync(path.join(modelDir(), 'encoder_model.onnx'));
}

// Byte-level BPE (as GPT-2): each byte is stored as a printable character; map them back.
let byteOf = null;
function bytesFor(piece) {
  if (!byteOf) {
    const keep = [];
    for (let b = 33; b <= 126; b++) keep.push(b);
    for (let b = 161; b <= 172; b++) keep.push(b);
    for (let b = 174; b <= 255; b++) keep.push(b);
    byteOf = new Map(keep.map((b) => [String.fromCharCode(b), b]));
    let n = 0;
    for (let b = 0; b < 256; b++) if (!keep.includes(b)) byteOf.set(String.fromCharCode(256 + n++), b);
  }
  return [...piece].map((ch) => byteOf.get(ch)).filter((b) => b !== undefined);
}

function decode(ids, tokens) {
  const bytes = [];
  for (const id of ids) if (id > 4 && tokens[id]) bytes.push(...bytesFor(tokens[id]));
  return Buffer.from(bytes).toString('utf8').trim();
}

let queue = Promise.resolve();
function readFormula(rgba) {
  const run = queue.then(() => read(rgba)); // one at a time: they'd only slow each other down
  queue = run.catch(() => {});
  return run;
}

/**
 * @param {Uint8Array|Buffer} rgba 384×384×4 pixels, dark ink on white
 * @returns {Promise<string>} LaTeX
 */
async function read(rgba) {
  const px = Buffer.isBuffer(rgba) || rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba);
  if (px.length !== SIZE * SIZE * 4) throw new Error('The math picture has the wrong size');
  const { ort, encoder, decoder, tokens } = await load();
  // Scale to −1…1 per channel, planes first, as the model's image processor does.
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) input[c * plane + i] = px[i * 4 + c] / 127.5 - 1;
  const { last_hidden_state: hidden } = await encoder.run({ pixel_values: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
  // Greedy decoding, one symbol at a time (this model keeps no cache, so each step reads all so far).
  const ids = [BOS];
  for (let step = 0; step < MAX_TOKENS; step++) {
    const { logits } = await decoder.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      encoder_hidden_states: hidden,
    });
    const V = logits.dims[2];
    const row = logits.data.subarray((ids.length - 1) * V, ids.length * V);
    let best = 0;
    for (let v = 1; v < V; v++) if (row[v] > row[best]) best = v;
    if (best === EOS) break;
    ids.push(best);
    // A model that's lost repeats itself: stop rather than read out nonsense for seconds.
    if (ids.length > 24 && ids.slice(-8).join() === ids.slice(-16, -8).join()) throw new Error('Couldn’t read that writing');
  }
  return decode(ids, tokens);
}

module.exports = { readFormula, available, warm: () => (available() ? load().then(() => true, () => false) : Promise.resolve(false)), SIZE };
