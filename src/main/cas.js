'use strict';
// Exact symbolic math (derivatives, integrals, limits, sums, vectors, factoring, solving) with
// nerdamer-prime, on a worker thread: a hard integral can take a long time, and it must never
// freeze Bigfoot. Each job has a time limit; a stuck worker is replaced.

const { Worker } = require('worker_threads');

const TIMEOUT_MS = 6000;

const WORKER = `
const { parentPort } = require('worker_threads');
const nerdamer = require(${JSON.stringify(require.resolve('nerdamer-prime'))});
require(${JSON.stringify(require.resolve('nerdamer-prime/Algebra'))});
require(${JSON.stringify(require.resolve('nerdamer-prime/Calculus'))});
require(${JSON.stringify(require.resolve('nerdamer-prime/Solve'))});

// A definite integral nerdamer leaves unevaluated (e.g. sin x from 0 to pi) is done numerically.
function numericDefint(src) {
  const m = /^defint\\((.*),([^,]+),([^,]+),\\s*([a-z])\\s*\\)$/i.exec(src.replace(/\\s+/g, ''));
  if (!m) return null;
  const f = nerdamer(m[1]).buildFunction([m[4]]);
  const a = Number(nerdamer(m[2]).evaluate().text('decimals'));
  const b = Number(nerdamer(m[3]).evaluate().text('decimals'));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const n = 2000;
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
  const v = (s * h) / 3;
  return Number.isFinite(v) ? v : null;
}

parentPort.on('message', ({ id, expr }) => {
  try {
    let r = nerdamer(expr);
    let text = r.toString();
    if (/defint\\(/.test(text)) {
      const v = numericDefint(expr);
      if (v == null) throw new Error('This integral has no closed form I can find');
      const rounded = Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : Number(v.toPrecision(10));
      parentPort.postMessage({ id, ok: true, text: String(rounded), decimal: null });
      return;
    }
    if (/\\b(diff|integrate|limit|solve|sum|product)\\(/.test(text)) throw new Error('Couldn’t work that out');
    let decimal = null;
    try {
      const d = r.evaluate().text('decimals');
      if (d !== text && /^-?[\\d.]+(e[-+]?\\d+)?$/i.test(d)) decimal = String(Number(Number(d).toPrecision(10)));
    } catch { /* symbolic result */ }
    parentPort.postMessage({ id, ok: true, text, decimal });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, message: String(err && err.message || err) });
  }
});
`;

let worker = null;
let seq = 0;
const waiting = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER, { eval: true });
  worker.on('message', (m) => {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    clearTimeout(w.timer);
    if (!waiting.size && worker) worker.unref(); // idle: never keeps Bigfoot (or a test run) alive
    if (m.ok) w.resolve(m);
    else w.reject(new Error(m.message));
  });
  worker.on('error', (err) => reset(err));
  worker.on('exit', () => reset(new Error('The math engine stopped')));
  worker.unref(); // after the listeners, which would otherwise hold it
  return worker;
}

function reset(err) {
  const w = worker;
  worker = null;
  for (const [id, job] of waiting) { clearTimeout(job.timer); job.reject(err); waiting.delete(id); }
  if (w) w.terminate().catch(() => {});
}

/** Handwriting and model notation → what nerdamer reads. */
function toCas(text) {
  return String(text || '')
    .replace(/[−–—]/g, '-').replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/π/g, 'pi').replace(/√/g, 'sqrt')
    .replace(/²/g, '^2').replace(/³/g, '^3').replace(/⟨|〈/g, '[').replace(/⟩|〉/g, ']')
    .replace(/\*\*/g, '^')
    .trim();
}

/** 2+3*x^2 → 3x² + 2 style is left to nerdamer; this just makes it easier to read. */
function tidy(text) {
  return String(text)
    .replace(/\*(?=[a-z(])/gi, '').replace(/\*/g, '·')
    .replace(/\^(\d+)/g, (m, d) => [...d].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[c]).join(''))
    .replace(/sqrt/g, '√').replace(/\bpi\b/g, 'π');
}

/**
 * Compute with the symbolic engine.
 * @returns {Promise<{ expression: string, answer: string, decimal: string|null }>}
 */
function compute(text, timeoutMs = TIMEOUT_MS) {
  const expr = toCas(text);
  if (!expr) return Promise.reject(new Error('Nothing to compute'));
  if (expr.length > 400 || /[;{}`$\\]|\b(require|import|process|function|constructor)\b/.test(expr)) {
    return Promise.reject(new Error('That isn’t math I can compute'));
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('That took too long to work out'));
      reset(new Error('timeout'));
    }, timeoutMs);
    waiting.set(id, {
      timer,
      reject,
      resolve: (m) => resolve({ expression: expr, answer: tidy(m.text), decimal: m.decimal, raw: m.text }),
    });
    const w = getWorker();
    w.ref();
    w.postMessage({ id, expr });
  });
}

/**
 * Calculus and vectors as people write them, in the notation compute() takes; null if it's
 * neither. d/dx x^3, ∫x^2dx, ∫(0,3) x^2 dx, [1,2,3]·[4,5,6], [1,2,3]×[4,5,6], |[3,4]|.
 */
function fromHandwriting(text) {
  const s = toCas(text).replace(/\s+/g, '').replace(/=+$/, '');
  let m = /^d(?:y)?\/d([a-z])\(?(.+?)\)?$/i.exec(s);
  if (m) return `diff(${m[2]},${m[1]})`;
  m = /^[∫Sf]_?\(?([^,()]+),([^,()]+)\)?(.+)d([a-z])$/.exec(s);
  if (m) return `defint(${m[3]},${m[1]},${m[2]},${m[4]})`;
  m = /^[∫Sf](.+)d([a-z])$/.exec(s);
  if (m) return `integrate(${m[1]},${m[2]})`;
  m = /^(\[[^\]]+\])[·.•](\[[^\]]+\])$/.exec(s);
  if (m) return `dot(${m[1]},${m[2]})`;
  m = /^(\[[^\]]+\])[*x](\[[^\]]+\])$/.exec(s);
  if (m) return `cross(${m[1]},${m[2]})`;
  m = /^\|(\[[^\]]+\])\|$/.exec(s);
  if (m) return `sqrt(dot(${m[1]},${m[1]}))`;
  if (/^\[[^\]]+\]([+\-*][\d.]*\[[^\]]+\])+$/.test(s) || /^[\d.]+\*?\[[^\]]+\]$/.test(s)) return s;
  m = /^lim\(?([a-z])(?:->|→)([^)]+)\)?(.+)$/i.exec(s);
  if (m) return `limit(${m[3]},${m[1]},${m[2]})`;
  return null;
}

/** The top-level terms of a sum: "x^3+2*sin(x)-4" → ["x^3", "+2*sin(x)", "-4"]. */
function terms(expr) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if ((ch === '+' || ch === '-') && depth === 0 && i > 0 && !/[*/^(e]/i.test(expr[i - 1])) {
      out.push(expr.slice(start, i));
      start = i;
    }
  }
  out.push(expr.slice(start));
  return out.map((t) => t.trim().replace(/^\+/, '')).filter(Boolean);
}

/** Split "f, a, b" at top-level commas. */
function args(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}

const vector = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) && v.every(Number.isFinite) ? v : null; } catch { return null; } };
const num = (n) => (n < 0 ? `(−${-n})` : String(n));

/**
 * The working for calculus and vectors, one line per step, computed by the same engine.
 * @returns {Promise<string[]>} empty when there's nothing worth showing
 */
async function working(form) {
  const m = /^(\w+)\((.*)\)$/.exec(toCas(form).replace(/\s+/g, ''));
  if (!m) return [];
  const [fn, inner] = [m[1], m[2]];
  const a = args(inner);
  const show = (s) => tidy(s).replace(/-/g, '−');
  const steps = [];
  try {
    if (fn === 'diff' && a.length === 2) {
      const parts = terms(a[0]);
      steps.push(`d/d${a[1]} [ ${show(a[0])} ]`);
      if (parts.length > 1) {
        steps.push('Differentiate each term:');
        for (const t of parts) steps.push(`   d/d${a[1]} ( ${show(t)} ) = ${show((await compute(`diff(${t},${a[1]})`)).raw)}`);
      }
      steps.push(`= ${show((await compute(form)).raw)}`);
    } else if (fn === 'integrate' && a.length === 2) {
      const parts = terms(a[0]);
      steps.push(`∫ ${show(a[0])} d${a[1]}`);
      if (parts.length > 1) {
        steps.push('Integrate each term:');
        for (const t of parts) steps.push(`   ∫ ${show(t)} d${a[1]} = ${show((await compute(`integrate(${t},${a[1]})`)).raw)}`);
      }
      steps.push(`= ${show((await compute(form)).raw)} + C`);
    } else if (fn === 'defint' && a.length === 4) {
      const [f, lo, hi, x] = a;
      const F = (await compute(`integrate(${f},${x})`)).raw;
      const at = (v) => F.replace(new RegExp(`\\b${x}\\b`, 'g'), `(${v})`);
      const Fb = await compute(at(hi));
      const Fa = await compute(at(lo));
      const total = await compute(form);
      steps.push(`∫ from ${show(lo)} to ${show(hi)} of ${show(f)} d${x}`);
      steps.push(`Antiderivative: F(${x}) = ${show(F)}`);
      steps.push(`F(${show(hi)}) = ${Fb.answer}${Fb.decimal ? ` ≈ ${Fb.decimal}` : ''}`);
      steps.push(`F(${show(lo)}) = ${Fa.answer}${Fa.decimal ? ` ≈ ${Fa.decimal}` : ''}`);
      steps.push(`F(${show(hi)}) − F(${show(lo)}) = ${total.answer}${total.decimal ? ` ≈ ${total.decimal}` : ''}`);
    } else if (fn === 'dot' && a.length === 2 && vector(a[0]) && vector(a[1])) {
      const [u, v] = [vector(a[0]), vector(a[1])];
      if (u.length !== v.length) return ['The vectors have different lengths, so they can’t be multiplied'];
      steps.push(`u · v = ${u.map((x, i) => `${num(x)}·${num(v[i])}`).join(' + ')}`);
      steps.push(`= ${u.map((x, i) => num(x * v[i])).join(' + ')}`);
      steps.push(`= ${u.reduce((s, x, i) => s + x * v[i], 0)}`);
    } else if (fn === 'cross' && a.length === 2 && vector(a[0]) && vector(a[1]) && vector(a[0]).length === 3 && vector(a[1]).length === 3) {
      const [[u1, u2, u3], [v1, v2, v3]] = [vector(a[0]), vector(a[1])];
      steps.push('u × v = (u₂v₃ − u₃v₂, u₃v₁ − u₁v₃, u₁v₂ − u₂v₁)');
      steps.push(`= (${num(u2)}·${num(v3)} − ${num(u3)}·${num(v2)}, ${num(u3)}·${num(v1)} − ${num(u1)}·${num(v3)}, ${num(u1)}·${num(v2)} − ${num(u2)}·${num(v1)})`);
      steps.push(`= (${u2 * v3 - u3 * v2}, ${u3 * v1 - u1 * v3}, ${u1 * v2 - u2 * v1})`);
    } else if (fn === 'limit' && a.length === 3) {
      steps.push(`lim ${a[1]}→${show(a[2])} of ${show(a[0])}`);
      const direct = await compute(a[0].replace(new RegExp(`\\b${a[1]}\\b`, 'g'), `(${a[2]})`)).catch(() => null);
      if (direct && !/nan|infinity|undefined/i.test(direct.raw)) steps.push(`Substitute ${a[1]} = ${show(a[2])}: ${direct.answer}`);
      else steps.push(`Substituting ${a[1]} = ${show(a[2])} directly gives 0/0 or ∞, so take the limit`);
      steps.push(`= ${(await compute(form)).answer}`);
    }
  } catch {
    return [];
  }
  return steps.map((s) => s.replace(/(^|[\s(=,[])-(?=[\d(a-z])/gi, '$1−'));
}

/** How a calculus or vector form reads on screen: d/dx (x³), ∫ x² dx, [1,2,3] · [4,5,6]. */
function display(form) {
  const m = /^(\w+)\((.*)\)$/.exec(String(form).replace(/\s+/g, ''));
  if (!m) return tidy(form);
  const a = args(m[2]);
  switch (m[1]) {
    case 'diff': return `d/d${a[1]} (${tidy(a[0])})`;
    case 'integrate': return `∫ ${tidy(a[0])} d${a[1]}`;
    case 'defint': return `∫ from ${tidy(a[1])} to ${tidy(a[2])} of ${tidy(a[0])} d${a[3]}`;
    case 'dot': return `${a[0]} · ${a[1]}`;
    case 'cross': return `${a[0]} × ${a[1]}`;
    case 'limit': return `lim ${a[1]}→${tidy(a[2])} ${tidy(a[0])}`;
    default: return tidy(form);
  }
}

module.exports = { compute, working, display, fromHandwriting, toCas, tidy };
