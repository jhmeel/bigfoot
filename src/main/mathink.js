'use strict';
// The model reads the handwriting; arithmetic is computed exactly by ./math, equations are left to the model.

const llm = require('./llm');
const { askLocal } = require('./llm/local');
const anthropic = require('./llm/anthropic');
const openai = require('./llm/openai');
const { evaluate } = require('./math');

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

module.exports = { readInk, parseReply, resolveAnswer, PROMPT };
