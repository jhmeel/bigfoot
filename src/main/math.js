'use strict';
// Exact arithmetic for the math tool (recursive descent, no eval).

const FUNCS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, ln: Math.log, log: Math.log10, exp: Math.exp,
  sin: (d) => roundTrig(Math.sin(rad(d))), cos: (d) => roundTrig(Math.cos(rad(d))), tan: (d) => roundTrig(Math.tan(rad(d))),
};
const CONSTS = { pi: Math.PI, e: Math.E };
const rad = (d) => (d * Math.PI) / 180;
const roundTrig = (v) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(v - Math.round(v)) < 1e-12 ? Math.round(v) : v);

class MathError extends Error {}

function normalize(text) {
  let s = String(text || '')
    .replace(/\\left|\\right/g, '')
    .replace(/\\(?:times|cdot)/g, '*').replace(/\\div/g, '/').replace(/\\pi/g, 'pi')
    .replace(/\\sqrt\s*\{([^}]*)\}/g, 'sqrt($1)').replace(/\\frac\s*\{([^}]*)\}\s*\{([^}]*)\}/g, '(($1)/($2))')
    .replace(/[{}]/g, (c) => (c === '{' ? '(' : ')'))
    .replace(/[×✕✖·∙•]/g, '*')
    .replace(/(\d|\))\s*[xX]\s*(?=\d|\()/g, '$1*') // "3 x 4" is times; "3x + 2" keeps its variable
    .replace(/[÷∕⁄:]/g, '/').replace(/[−–—]/g, '-').replace(/\*\*/g, '^')
    .replace(/√/g, 'sqrt').replace(/π/g, 'pi')
    .replace(/[²]/g, '^2').replace(/[³]/g, '^3')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .trim();
  s = s.replace(/=\s*\??\s*$/, '').trim();
  return s;
}

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+\.?\d*|\.\d+)(?:e([+-]?\d+))?|([a-z]+)|(\S))/giy;
  let m;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1] + (m[2] !== undefined ? `e${m[2]}` : '')) });
    else if (m[3] !== undefined) tokens.push({ t: 'id', v: m[3].toLowerCase() });
    else if (m[4] !== undefined) {
      if (!'+-*/^()!%|'.includes(m[4])) throw new MathError(`Unexpected "${m[4]}"`);
      tokens.push({ t: 'op', v: m[4] });
    }
  }
  return tokens;
}

function parse(src) {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  const take = (v) => { if (!isOp(v)) throw new MathError(`Expected "${v}"`); i++; };

  function expr() {
    let v = term();
    while (isOp('+') || isOp('-')) v = tokens[i++].v === '+' ? v + term() : v - term();
    return v;
  }
  function startsPrimary() {
    const t = peek();
    return t && (t.t === 'num' || t.t === 'id' || (t.t === 'op' && t.v === '('));
  }
  function term() {
    let v = unary();
    for (;;) {
      if (isOp('*')) { i++; v *= unary(); } else if (isOp('/')) {
        i++;
        const d = unary();
        if (d === 0) throw new MathError('Division by zero');
        v /= d;
      } else if (startsPrimary()) v *= power(); // implicit: 2(3+4), 2pi, 3 sqrt 4
      else return v;
    }
  }
  function unary() {
    if (isOp('-')) { i++; return -unary(); }
    if (isOp('+')) { i++; return unary(); }
    return power();
  }
  function power() {
    const base = postfix();
    if (isOp('^')) { i++; return base ** unary(); }
    return base;
  }
  function postfix() {
    let v = primary();
    for (;;) {
      if (isOp('!')) {
        i++;
        if (!Number.isInteger(v) || v < 0 || v > 170) throw new MathError('Factorial needs a whole number up to 170');
        let f = 1;
        for (let k = 2; k <= v; k++) f *= k;
        v = f;
      } else if (isOp('%')) { i++; v /= 100; } else return v;
    }
  }
  function primary() {
    const t = peek();
    if (!t) throw new MathError('The expression ends too early');
    if (t.t === 'num') { i++; return t.v; }
    if (t.t === 'op' && t.v === '(') { i++; const v = expr(); take(')'); return v; }
    if (t.t === 'op' && t.v === '|') { i++; const v = expr(); take('|'); return Math.abs(v); }
    if (t.t === 'id') {
      i++;
      if (t.v in CONSTS) return CONSTS[t.v];
      if (t.v in FUNCS) return FUNCS[t.v](isOp('(') ? primary() : power());
      throw new MathError(`Unknown name "${t.v}"`);
    }
    throw new MathError(`Unexpected "${t.v}"`);
  }

  if (!tokens.length) throw new MathError('Nothing to calculate');
  const v = expr();
  if (i < tokens.length) throw new MathError(`Unexpected "${tokens[i].v}"`);
  if (!Number.isFinite(v)) throw new MathError('The result is too large');
  return v;
}

function format(v) {
  if (Object.is(v, -0)) v = 0;
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) return v.toExponential(9).replace(/\.?0+e/, 'e');
  return String(Number(v.toPrecision(12)));
}

function evaluate(text) {
  const expression = normalize(text);
  if (expression.includes('=')) throw new MathError('That’s an equation');
  if (tokenize(expression).some((t) => t.t === 'id' && !(t.v in FUNCS) && !(t.v in CONSTS))) {
    throw new MathError('That has a variable in it');
  }
  const value = parse(expression);
  return { expression, value, text: format(value) };
}

module.exports = { evaluate, normalize, format, parse, MathError };
