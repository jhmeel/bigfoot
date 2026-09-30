'use strict';
// The model reads the handwriting; arithmetic is computed exactly by ./math, equations are left to the model.

const llm = require('./llm');
const { askLocal } = require('./llm/local');
const anthropic = require('./llm/anthropic');
const openai = require('./llm/openai');
const { evaluate, normalize, solveEquation } = require('./math');

const PROMPT = `This image is handwriting on a digital whiteboard. Read the math the person wrote.
Reply with JSON only, no other text:
{"expression": "<exactly what was written, as one line of plain math: digits, + - * / ^ ( ), sqrt(), pi, and letters for variables>", "answer": "<the result, or the solution such as x = 2; empty if it can't be worked out>"}
If there is no math or it is unreadable, reply {"expression": "", "answer": ""}.`;

function parseReply(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return { expression: '', answer: '' };
  try {
    const j = JSON.parse(m[0]);
    return { expression: String(j.expression || '').trim().slice(0, 200), answer: String(j.answer || '').trim().slice(0, 60) };
  } catch {
    return { expression: '', answer: '' };
  }
}

function resolveAnswer({ expression, answer }) {
  if (!expression) return { expression: '', answer: '', exact: false };
  try {
    const r = evaluate(expression);
    return { expression: r.expression, answer: r.text, exact: true };
  } catch {
    const clean = answer.replace(/^=\s*/, '').replace(/[`$\\]/g, '').trim();
    return { expression, answer: clean, exact: false };
  }
}

// ---------------------------------------------------------------- live handwriting (Windows recognizer)

// Only shapes that are rarely a variable; b, q, z, t, s… stay letters so "2b + 1 = 7" is an equation.
const DIGIT_LOOKALIKES = { l: '1', I: '1', '|': '1', O: '0', o: '0', S: '5', Z: '2', B: '8' };
const pretty = (s) => s.replace(/\*/g, '×').replace(/\//g, '÷').replace(/\s*([+\-×÷=])\s*/g, ' $1 ').replace(/\s+/g, ' ').trim();

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
 * Understand what was written.
 * @returns {{ text, status, answer?, given?, expression? }} status is one of
 *   'writing' (a sum, no "="), 'answer' (a sum ending with "="), 'right' / 'wrong' (the user's own
 *   answer checked), 'solved' (one unknown, solved here), 'solve' (needs the model), 'unknown'.
 * Nothing is shown until the user presses Solve; this only prepares the answer.
 */
function interpretInk(segments) {
  const candidates = readings(segments).map((r) => r.replace(/\s+/g, ''));
  if (!candidates.length || !candidates[0]) return { text: '', status: 'unknown' };
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
        if (sol) return { text: pretty(sol.expression), status: 'solved', answer: sol.text, expression: sol.expression };
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
  // Letters that aren't digits: an equation to solve, which needs the model.
  const best = digitize(candidates[0]);
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
  } else {
    reply = await openai.ask({ key: settings.secret('openaiKey'), model: settings.get('openaiModel'), prompt: PROMPT, image, signal });
  }
  return resolveAnswer(parseReply(reply));
}

module.exports = { readInk, interpretInk, readings, digitize, parseReply, resolveAnswer, PROMPT };
