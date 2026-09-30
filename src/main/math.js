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
    else if (m[3] !== undefined) {
      const id = m[3].toLowerCase();
      if (id in FUNCS || id in CONSTS || id.length === 1) tokens.push({ t: 'id', v: id });
      else for (const ch of id) tokens.push({ t: 'id', v: ch }); // "xy" is x times y
    }
    else if (m[4] !== undefined) {
      if (!'+-*/^()!%|'.includes(m[4])) throw new MathError(`Unexpected "${m[4]}"`);
      tokens.push({ t: 'op', v: m[4] });
    }
  }
  return tokens;
}

function parse(src, vars = {}) {
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
      if (t.v in vars) return vars[t.v];
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

const unknowns = (expression) => [...new Set(tokenize(expression.replace(/=/g, '+'))
  .filter((t) => t.t === 'id' && !(t.v in FUNCS) && !(t.v in CONSTS)).map((t) => t.v))];

/** 2.333… shows as 7/3; anything else as a decimal. */
function nice(v) {
  if (Math.abs(v - Math.round(v)) < 1e-9) return format(Math.round(v));
  for (let d = 2; d <= 16; d++) {
    const n = Math.round(v * d);
    if (Math.abs(v * d - n) < 1e-9) return `${n}/${d}`;
  }
  return format(Number(v.toPrecision(10)));
}

/**
 * Solve an equation in one unknown: linear and quadratic exactly, anything else numerically.
 * @returns {{ expression, variable, roots: number[], text }}
 */
function solveEquation(text) {
  const expression = normalize(text);
  const sides = expression.split('=');
  if (sides.length !== 2 || !sides[0].trim() || !sides[1].trim()) throw new MathError('Not an equation');
  const names = unknowns(expression);
  if (names.length !== 1) throw new MathError(names.length ? 'More than one unknown' : 'No unknown');
  const [v] = names;
  const f = (x) => {
    try { return parse(sides[0], { [v]: x }) - parse(sides[1], { [v]: x }); } catch (err) {
      if (err instanceof MathError && /Division|large|Factorial/.test(err.message)) return NaN;
      throw err;
    }
  };
  f(0.123); // throws on anything that can't be parsed

  const [fm, f0, fp] = [f(-1), f(0), f(1)];
  const a = (fp + fm) / 2 - f0;
  const b = (fp - fm) / 2;
  const c = f0;
  const fits = [2, 3, -2.5, 0.5, 7].every((x) => {
    const got = f(x);
    return Number.isFinite(got) && Math.abs(got - (a * x * x + b * x + c)) <= 1e-7 * Math.max(1, Math.abs(got));
  });
  const tiny = (n) => Math.abs(n) < 1e-12;
  let roots;
  if (fits && tiny(a)) {
    if (tiny(b)) return { expression, variable: v, roots: [], text: tiny(c) ? 'any value' : 'no solution' };
    roots = [-c / b];
  } else if (fits) {
    const disc = b * b - 4 * a * c;
    if (disc < -1e-12) return { expression, variable: v, roots: [], text: 'no real solution' };
    const r = Math.sqrt(Math.max(0, disc));
    roots = tiny(r) ? [-b / (2 * a)] : [(-b - r) / (2 * a), (-b + r) / (2 * a)];
  } else {
    roots = [];
    const step = 0.05;
    let px = -200;
    let py = f(px);
    for (let x = px + step; x <= 200 && roots.length < 4; x += step) {
      const y = f(x);
      if (Number.isFinite(py) && Number.isFinite(y) && Math.sign(py) !== Math.sign(y)) {
        let lo = px;
        let hi = x;
        for (let k = 0; k < 60; k++) {
          const mid = (lo + hi) / 2;
          if (Math.sign(f(mid)) === Math.sign(f(lo))) lo = mid; else hi = mid;
        }
        const root = (lo + hi) / 2;
        if (Math.abs(f(root)) < 1e-6) roots.push(root); // a sign change at a pole isn't a root
      }
      px = x;
      py = y;
    }
    if (!roots.length) throw new MathError('No solution found');
  }
  roots = roots.map((r) => (Object.is(r, -0) ? 0 : r)).sort((p, q) => p - q);
  return { expression, variable: v, roots, text: `${v} = ${roots.map(nice).join(', ')}` };
}

module.exports = { evaluate, normalize, format, parse, solveEquation, unknowns, MathError };
