'use strict';
// Windows reads the handwriting live; anything it can't, the AI model reads. The answer is always
// computed here (./math for sums and equations, ./cas for calculus and vectors), never guessed.

const llm = require('./llm');
const { askLocal } = require('./llm/local');
const anthropic = require('./llm/anthropic');
const openai = require('./llm/openai');
const custom = require('./llm/custom');
const { evaluate, normalize, solveEquation, solveSystem, unknowns } = require('./math');
const cas = require('./cas');

const PROMPT = `This image is handwriting on a digital whiteboard. Read the math the person wrote; don't solve it.
Reply with JSON only, no other text:
{"expression": "<what was written, as one line: digits, + - * / ^ ( ), sqrt(), pi, e, sin cos tan log ln, letters for variables>", "compute": "<the same written as ONE call when it is calculus, vectors, or a system: diff(f, x) for a derivative, integrate(f, x) for an integral, defint(f, a, b, x) for an integral from a to b, limit(f, x, a), sum(f, k, a, b), vectors as [1,2,3] with dot(u, v), cross(u, v), u + v, 3*u; several equations on separate lines as system(eq1; eq2); otherwise empty>"}
Write powers with ^ (x^2, e^(2x)) and multiplication with * (2*x). If there is no math or it is unreadable, reply {"expression": "", "compute": ""}.`;

function parseReply(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return { expression: '', compute: '' };
  try {
    const j = JSON.parse(m[0]);
    return { expression: String(j.expression || '').trim().slice(0, 200), compute: String(j.compute || '').trim().slice(0, 300) };
  } catch {
    return { expression: '', compute: '' };
  }
}

/** The exact answer for what the model read. Never the model's own arithmetic. */
async function resolveAnswer({ expression, compute }) {
  if (!expression && !compute) return { expression: '', answer: '', exact: false };
  const sys = /^system\((.*)\)$/i.exec(compute || '');
  if (sys) {
    try { const r = solveSystem(sys[1].split(';')); return { expression: compute, answer: r.text, steps: r.steps, exact: true }; } catch { /* below */ }
  }
  const viaCas = async (form, shown) => {
    const r = await cas.compute(form);
    return { expression: shown, answer: r.answer + (r.decimal ? ` ≈ ${r.decimal}` : ''), steps: await cas.working(form), exact: true };
  };
  if (compute) {
    try { return await viaCas(compute, cas.display(compute)); } catch { /* below */ }
  }
  try { const r = evaluate(expression); return { expression: r.expression, answer: r.text, exact: true }; } catch { /* below */ }
  try { const r = solveEquation(expression); return { expression: r.expression, answer: r.text, steps: r.steps, exact: true }; } catch { /* below */ }
  const hand = cas.fromHandwriting(expression);
  const eq = expression.split('=');
  const attempt = hand || (eq.length === 2 ? `solve(${eq[0]}-(${eq[1]}), ${unknowns(normalize(expression))[0] || 'x'})` : `simplify(${expression})`);
  try { return await viaCas(attempt, expression); } catch { /* nothing */ }
  return { expression, answer: '', exact: false };
}

// live handwriting (Windows recognizer)

// Only shapes that are rarely a variable; b, q, z, t, s… stay letters so "2b + 1 = 7" is an equation.
const DIGIT_LOOKALIKES = { l: '1', I: '1', '|': '1', O: '0', o: '0', S: '5', Z: '2', B: '8' };
const SUPER = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', n: 'ⁿ', x: 'ˣ', y: 'ʸ', i: 'ⁱ', '-': '⁻' };
const superscript = (s) => ([...s].every((ch) => SUPER[ch]) ? [...s].map((ch) => SUPER[ch]).join('') : null);
const pretty = (s) => s
  .replace(/\^\(([^()]+)\)|\^([\dnxy])/g, (m, a, b) => superscript(a || b) || m)
  .replace(/sqrt\(([\w.]+)\)/g, '√$1').replace(/sqrt\(/g, '√(').replace(/\bpi\b/g, 'π')
  .replace(/\*/g, '×').replace(/\//g, '÷').replace(/\s*([+\-×÷=])\s*/g, ' $1 ').replace(/\s+/g, ' ').trim();

/**
 * Handwritten powers: strokes that sit high and small next to the main line (the 2 in x²).
 * The recognizer only returns plain text, so they are found here and read on their own.
 * @param {{x:number,y:number}[][]} strokes
 * @returns {{ sup: boolean, strokes: {x:number,y:number}[][] }[]} runs from left to right
 */
function splitScripts(strokes) {
  const boxes = strokes.map((s, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of s) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { i, x0, y0, x1, y1, h: y1 - y0, cy: (y0 + y1) / 2, cx: (x0 + x1) / 2 };
  });
  if (boxes.length < 2) return [{ sup: false, strokes }];
  const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  const maxH = Math.max(...boxes.map((b) => b.h));
  const tall = boxes.filter((b) => b.h >= maxH * 0.45);
  const H = median(tall.map((b) => b.h));
  const mid = median(tall.map((b) => b.cy));
  if (!(H > 8)) return [{ sup: false, strokes }];
  const leftmost = Math.min(...boxes.map((b) => b.x0));
  for (const b of boxes) b.sup = b.h >= H * 0.2 && b.h <= H * 0.8 && b.cy < mid - H * 0.3 && b.x0 > leftmost + H * 0.3;
  // Bars and dots that belong to a raised character (the bar of a raised 4 or +) go with it.
  for (const b of boxes) {
    if (b.sup || b.h >= H * 0.2) continue;
    b.sup = boxes.some((s) => s.sup && b.cx >= s.x0 - H * 0.15 && b.cx <= s.x1 + H * 0.15 && b.cy >= s.y0 - H * 0.1 && b.cy <= s.y1 + H * 0.1);
  }
  if (!boxes.some((b) => b.sup)) return [{ sup: false, strokes }];
  const runs = [];
  for (const b of [...boxes].sort((p, q) => p.cx - q.cx)) {
    const last = runs[runs.length - 1];
    if (last && last.sup === b.sup) last.strokes.push(strokes[b.i]);
    else runs.push({ sup: b.sup, strokes: [strokes[b.i]] });
  }
  return runs;
}

/** The recognizer's readings, best first: every mix of the top few candidates per segment. */
function readings(segments, perSegment = 4, max = 64) {
  let out = [''];
  for (const seg of segments) {
    const next = [];
    for (const prefix of out) for (const c of seg.slice(0, perSegment)) next.push(prefix + c);
    out = next.slice(0, max);
  }
  return out;
}

/** Letters that are usually digits in handwriting, swapped only where they sit among numbers. */
function digitize(text) {
  return text.replace(/[lI|OoSZB]/g, (ch, at, s) => {
    const around = `${s[at - 1] || ''}${s[at + 1] || ''}`;
    return /[\d+\-*/×÷=().\s]/.test(around) || !around ? DIGIT_LOOKALIKES[ch] : ch;
  });
}

function tryEvaluate(text) {
  try { return evaluate(text); } catch { return null; }
}

function trySolve(text) {
  try { return solveEquation(text); } catch { return null; }
}

/**
 * Interpret the recognizer's readings.
 * @returns {{ text, status, answer?, given?, expression? }} status is one of
 *   'writing' (a sum, no "="), 'answer' (a sum ending with "="), 'right' / 'wrong' (the user's own
 *   answer checked), 'solved' (one unknown, solved here), 'solve' (needs the model), 'unknown'.
 * Nothing is shown until the user presses Solve; this only prepares the answer.
 */
function interpretInk(segments) {
  const all = readings(segments).map((r) => r.replace(/\s+/g, ''));
  if (!all.length || !all[0]) return { text: '', status: 'unknown' };
  // Trust the recognizer's best reading about letters vs numbers: when it read a letter (2x, y),
  // a lower-ranked all-digit reading (24, 2) must never replace it just because it can be computed.
  const hasVariable = (t) => /[a-z]/i.test(digitize(t).replace(/sqrt|sin|cos|tan|log|ln|pi|lim/gi, ''));
  const candidates = hasVariable(all[0]) ? all.filter(hasVariable) : all;
  for (const raw of candidates) {
    for (const text of [raw, digitize(raw)]) {
      const norm = normalize(text);
      const eq = text.indexOf('=');
      if (eq < 0) {
        const r = tryEvaluate(norm);
        if (r) return { text: pretty(r.expression), status: 'writing', answer: r.text, expression: r.expression };
        continue;
      }
      const left = text.slice(0, eq);
      const right = text.slice(eq + 1).replace(/=/g, '');
      const lhs = tryEvaluate(left);
      if (right && (!lhs || !tryEvaluate(right))) {
        const sol = trySolve(text);
        if (sol) {
          const several = unknowns(sol.expression).length > 1; // may be solvable together with other lines
          return { text: pretty(sol.expression), status: 'solved', answer: sol.text, expression: sol.expression, system: several, steps: sol.steps };
        }
      }
      if (lhs && !right) return { text: `${pretty(lhs.expression)} =`, status: 'answer', answer: lhs.text, expression: lhs.expression };
      if (lhs) {
        const given = tryEvaluate(right);
        if (given) {
          const ok = Math.abs(given.value - lhs.value) <= 1e-9 * Math.max(1, Math.abs(lhs.value));
          return { text: `${pretty(lhs.expression)} = ${pretty(given.expression)}`, status: ok ? 'right' : 'wrong', answer: lhs.text, given: given.text, expression: lhs.expression };
        }
      }
    }
  }
  // Calculus and vectors (d/dx …, ∫ … dx, [1,2]·[3,4]) are computed by ./cas; see readMathInk.
  for (const raw of candidates.slice(0, 8)) {
    const form = cas.fromHandwriting(raw);
    if (form) return { text: cas.display(form), status: 'compute', compute: form, expression: raw };
  }
  // Letters that aren't digits: an equation to solve, which needs the model.
  const best = digitize(candidates[0]);
  const isWord = /[a-z]{3,}/i.test(best.replace(/sqrt|sin|cos|tan|log|ln|pi|lim/gi, '')); // "hello" is writing, not algebra
  if (!best.includes('=') && hasVariable(best) && !isWord) {
    // Algebra without "=" (2x, 3x + 2x, (x+1)^2): shown as written, simplified by the math engine.
    const expr = normalize(best);
    return { text: pretty(expr), status: 'compute', compute: `simplify(${expr})`, expression: expr };
  }
  if (/[a-z]/i.test(best.replace(/sqrt|sin|cos|tan|log|ln|pi/gi, '')) && /[=]/.test(best)) {
    return { text: pretty(normalize(best)), status: 'solve', expression: normalize(best) };
  }
  return { text: pretty(candidates[0]), status: 'unknown' };
}

/** @returns {Promise<{ expression: string, answer: string, exact: boolean }>} */
async function readInk({ png, settings, runtime, online = true, signal }) {
  const image = png.toString('base64');
  const id = llm.resolveProvider(settings, { online });
  if (!id) throw new llm.ProviderError('Set up your local AI in Settings › Models to use the math tool.', 'Set up your local AI');
  let reply;
  if (id === 'local') {
    reply = await askLocal(runtime, { prompt: PROMPT, image, signal, maxTokens: 200 });
  } else if (id === 'anthropic') {
    reply = await anthropic.ask({ apiKey: settings.secret('anthropicKey'), model: settings.get('model'), prompt: PROMPT, image, signal });
  } else if (id === 'custom') {
    reply = await custom.ask({ baseUrl: settings.get('customBaseUrl'), key: settings.secret('customKey'), model: settings.get('customModel'), prompt: PROMPT, image, signal });
  } else {
    reply = await openai.ask({ key: settings.secret('openaiKey'), model: settings.get('openaiModel'), prompt: PROMPT, image, signal });
  }
  return resolveAnswer(parseReply(reply));
}

module.exports = { readInk, interpretInk, readings, digitize, splitScripts, pretty, parseReply, resolveAnswer, PROMPT };
