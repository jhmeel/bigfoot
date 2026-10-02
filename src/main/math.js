'use strict';
// Exact arithmetic for the math tool (recursive descent, no eval).

class MathError extends Error {}

// Angles are in degrees unless the calculator is switched to radians (set per evaluation).
let angleMode = 'deg';
const toRad = (x) => (angleMode === 'deg' ? (x * Math.PI) / 180 : x);
const fromRad = (x) => (angleMode === 'deg' ? (x * 180) / Math.PI : x);
const roundTrig = (v) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(v - Math.round(v)) < 1e-12 ? Math.round(v) : v);
const need = (ok, message) => { if (!ok) throw new MathError(message); };

// Same results and the same errors as a standard scientific calculator.
const FUNCS = {
  sqrt: (x) => { need(x >= 0, 'The square root of a negative number isn’t a real number'); return Math.sqrt(x); },
  cbrt: Math.cbrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: (x) => { need(x > 0, 'ln needs a number greater than 0'); return Math.log(x); },
  log: (x) => { need(x > 0, 'log needs a number greater than 0'); return Math.log10(x); },
  sin: (x) => roundTrig(Math.sin(toRad(x))),
  cos: (x) => roundTrig(Math.cos(toRad(x))),
  tan: (x) => {
    need(Math.abs(Math.cos(toRad(x))) > 1e-12, `tan is undefined at ${angleMode === 'deg' ? `${x}°` : x}`);
    return roundTrig(Math.tan(toRad(x)));
  },
  asin: (x) => { need(x >= -1 && x <= 1, 'sin⁻¹ needs a value between −1 and 1'); return roundTrig(fromRad(Math.asin(x))); },
  acos: (x) => { need(x >= -1 && x <= 1, 'cos⁻¹ needs a value between −1 and 1'); return roundTrig(fromRad(Math.acos(x))); },
  atan: (x) => roundTrig(fromRad(Math.atan(x))),
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
};
FUNCS.arcsin = FUNCS.asin;
FUNCS.arccos = FUNCS.acos;
FUNCS.arctan = FUNCS.atan;
const CONSTS = { pi: Math.PI, e: Math.E };

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
        if (d === 0) throw new MathError('You can’t divide by zero');
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
  if (Number.isNaN(v)) throw new MathError('That isn’t a real number');
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

/** @param {{ angle?: 'deg'|'rad' }} [options] trig in degrees (default) or radians */
function evaluate(text, { angle = 'deg' } = {}) {
  const expression = normalize(text);
  if (expression.includes('=')) throw new MathError('That’s an equation');
  if (tokenize(expression).some((t) => t.t === 'id' && !(t.v in FUNCS) && !(t.v in CONSTS))) {
    throw new MathError('That has a variable in it');
  }
  angleMode = angle === 'rad' ? 'rad' : 'deg';
  try {
    const value = parse(expression);
    return { expression, value, text: format(value) };
  } finally {
    angleMode = 'deg';
  }
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

// showing the working
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
/** An expression as people write it: 2·x → 2x, x^2 → x², spaces around = + −. */
function show(s) {
  return String(s)
    .replace(/\^\(?(\d+)\)?/g, (m, d) => [...d].map((c) => SUP[c]).join(''))
    .replace(/(\d)\*(?=[a-z(])/gi, '$1').replace(/\*/g, '·').replace(/-/g, '−')
    .replace(/\s*([=+−])\s*/g, ' $1 ').replace(/\(\s*−\s*/g, '(−').replace(/^\s*−\s*/, '−')
    .replace(/\s+/g, ' ').trim();
}

/** Σ coef·name in order, e.g. [[2,'x²'],[-5,'x'],[6,'']] → 2x² − 5x + 6 (zero terms left out). */
function sumText(terms) {
  const parts = [];
  for (const [k, name] of terms) {
    if (Math.abs(k) < 1e-12) continue;
    const n = nice(Math.abs(k));
    const body = !name ? n : n === '1' ? name : n.includes('/') ? `(${n})${name}` : `${n}${name}`;
    parts.push(parts.length ? `${k < 0 ? '−' : '+'} ${body}` : `${k < 0 ? '−' : ''}${body}`);
  }
  return parts.length ? parts.join(' ') : '0';
}
const signed = (n) => (n < 0 ? `(−${nice(-n)})` : nice(n));
const minus = (s) => s.replace(/(^|[\s(=,])-(?=\d)/g, '$1−');

/**
 * Solve an equation in one unknown: linear and quadratic exactly, anything else numerically.
 * @returns {{ expression, variable, roots: number[], text, steps: string[] }}
 */
function solveEquation(text) {
  const expression = normalize(text);
  const sides = expression.split('=');
  if (sides.length !== 2 || !sides[0].trim() || !sides[1].trim()) throw new MathError('Not an equation');
  const names = unknowns(expression);
  if (!names.length) throw new MathError('No unknown');
  if (names.length > 1) return solveForOne(expression, sides, names);
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
  const steps = [show(expression)];
  let roots;
  if (fits && tiny(a)) {
    steps.push(`Bring everything to one side: ${sumText([[b, v], [c, '']])} = 0`);
    if (tiny(b)) {
      steps.push(tiny(c) ? 'Both sides are always equal' : `That says ${nice(c)} = 0, which is never true`);
      return { expression, variable: v, roots: [], text: tiny(c) ? 'any value' : 'no solution', steps: steps.map(minus) };
    }
    steps.push(`${sumText([[b, v]])} = ${nice(-c)}`);
    if (Math.abs(b - 1) > 1e-12) steps.push(`Divide both sides by ${signed(b)}: ${v} = ${nice(-c)} ÷ ${signed(b)}`);
    roots = [-c / b];
  } else if (fits) {
    const disc = b * b - 4 * a * c;
    steps.push(`Standard form: ${sumText([[a, `${v}²`], [b, v], [c, '']])} = 0   (a = ${nice(a)}, b = ${nice(b)}, c = ${nice(c)})`);
    steps.push(`Discriminant: b² − 4ac = ${signed(b)}² − 4·${signed(a)}·${signed(c)} = ${nice(disc)}`);
    if (disc < -1e-12) {
      steps.push('It is negative, so there is no real solution');
      return { expression, variable: v, roots: [], text: 'no real solution', steps: steps.map(minus) };
    }
    const r = Math.sqrt(Math.max(0, disc));
    steps.push(`${v} = (−b ± √${nice(disc)}) ÷ 2a = (${nice(-b)} ± ${nice(r)}) ÷ ${nice(2 * a)}`);
    roots = tiny(r) ? [-b / (2 * a)] : [(-b - r) / (2 * a), (-b + r) / (2 * a)];
  } else {
    steps.push('Not linear or quadratic: the solution is found by narrowing in on where both sides are equal');
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
  const answer = `${v} = ${roots.map(nice).join(', ')}`;
  steps.push(roots.length > 1 ? roots.map((r) => `${v} = ${nice(r)}`).join('  or  ') : answer);
  return { expression, variable: v, roots, text: answer, steps: steps.map(minus) };
}

/**
 * left − right as c + Σ coef·var when it's linear in every unknown, else null.
 * Checked at several points, so x·y or x² are never mistaken for linear.
 */
function linearForm(sides, names) {
  const f = (vals) => parse(sides[0], vals) - parse(sides[1], vals);
  const zero = Object.fromEntries(names.map((n) => [n, 0]));
  let c;
  let coef;
  try {
    c = f(zero);
    coef = names.map((n) => f({ ...zero, [n]: 1 }) - c);
    for (const t of [1.7, -2.3, 3.1, 0.45]) {
      const vals = Object.fromEntries(names.map((n, i) => [n, t * (i + 1.3) - i]));
      const got = f(vals);
      const want = c + names.reduce((s, n, i) => s + coef[i] * vals[n], 0);
      if (!Number.isFinite(got) || Math.abs(got - want) > 1e-7 * Math.max(1, Math.abs(got))) return null;
    }
  } catch {
    return null;
  }
  return { c, coef };
}

/** 3 − x, x/2 + 1, −2a + b: a linear expression in readable form. */
function linearText(constant, terms) {
  const parts = [];
  for (const [k, name] of terms) {
    if (Math.abs(k) < 1e-12) continue;
    const mag = Math.abs(k);
    const n = nice(mag);
    const term = n === '1' ? name : n.includes('/') ? `${n.split('/')[0] === '1' ? '' : n.split('/')[0]}${name}/${n.split('/')[1]}` : `${n}${name}`;
    parts.push([k < 0, term]);
  }
  if (Math.abs(constant) > 1e-12 || !parts.length) parts.unshift([constant < 0, nice(Math.abs(constant))]);
  return parts.map(([neg, t], i) => (i === 0 ? (neg ? `−${t}` : t) : `${neg ? '−' : '+'} ${t}`)).join(' ');
}

/** One linear equation, several unknowns: solve for one of them (y if it's there). */
function solveForOne(expression, sides, names) {
  const form = linearForm(sides, names);
  if (!form) throw new MathError('Not linear in its unknowns');
  const order = [...names].sort((a, b) => (b === 'y') - (a === 'y') || b.localeCompare(a));
  const v = order.find((n) => Math.abs(form.coef[names.indexOf(n)]) > 1e-12);
  if (!v) throw new MathError('No unknown left after simplifying');
  const a = form.coef[names.indexOf(v)];
  const others = names.filter((n) => n !== v).sort();
  const rest = others.map((n) => [-form.coef[names.indexOf(n)] / a, n]);
  const text = `${v} = ${linearText(-form.c / a, rest)}`;
  const steps = [
    show(expression),
    `Bring everything to one side: ${sumText([...names.map((n) => [form.coef[names.indexOf(n)], n]), [form.c, '']])} = 0`,
    `Keep ${v} on the left: ${sumText([[a, v]])} = ${sumText([[-form.c, ''], ...others.map((n) => [-form.coef[names.indexOf(n)], n])])}`,
  ];
  if (Math.abs(a - 1) > 1e-12) steps.push(`Divide by ${signed(a)}: ${text}`);
  else steps.push(text);
  steps.push(`One equation with ${names.length} unknowns has many solutions; add ${names.length - 1 === 1 ? 'another equation' : `${names.length - 1} more equations`} to pin them down`);
  return { expression, variable: v, roots: [], text, steps: steps.map(minus) };
}

/**
 * Several linear equations together (one per line): the values that satisfy all of them.
 * @returns {{ values: Record<string, number>, text }} or throws when there's no single answer.
 */
function solveSystem(texts) {
  const eqs = texts.map((t) => normalize(t)).filter((e) => e.split('=').length === 2);
  const names = [...new Set(eqs.flatMap(unknowns))].sort();
  if (names.length < 2 || eqs.length < names.length) throw new MathError('Needs as many equations as unknowns');
  const rows = eqs.map((e) => {
    const form = linearForm(e.split('='), names);
    if (!form) throw new MathError('Only linear equations can be solved together');
    return [...form.coef, -form.c];
  });
  // Gaussian elimination with partial pivoting; each elimination is written out.
  const m = names.length;
  const rowText = (r) => `${sumText(names.map((n, j) => [r[j], n]))} = ${nice(r[m])}`;
  const steps = eqs.map((e, i) => `(${i + 1})  ${show(e)}`);
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < rows.length; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    if (Math.abs(rows[pivot][col]) < 1e-10) throw new MathError('These equations don’t have a single answer');
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    for (let r = 0; r < rows.length; r++) {
      if (r === col) continue;
      const k = rows[r][col] / rows[col][col];
      if (Math.abs(k) < 1e-12) continue;
      for (let j = col; j <= m; j++) rows[r][j] -= k * rows[col][j];
      if (steps.length < 14) steps.push(`Remove ${names[col]} from equation ${r + 1} (${k < 0 ? 'add' : 'subtract'} ${nice(Math.abs(k)) === '1' ? '' : `${nice(Math.abs(k))} × `}equation ${col + 1}): ${rowText(rows[r])}`);
    }
  }
  for (let r = m; r < rows.length; r++) if (Math.abs(rows[r][m]) > 1e-7) throw new MathError('These equations contradict each other');
  const values = Object.fromEntries(names.map((n, i) => [n, rows[i][m] / rows[i][i]]));
  names.forEach((n, i) => { if (Math.abs(rows[i][i] - 1) > 1e-12) steps.push(`Divide by ${signed(rows[i][i])}: ${n} = ${nice(values[n])}`); });
  const answer = names.map((n) => `${n} = ${nice(values[n])}`).join(', ');
  steps.push(`So ${answer}. Check: ${eqs.map((e) => show(e)).join(' and ')} both hold ✓`.replace('both', eqs.length > 2 ? 'all' : 'both'));
  return { values, text: answer, steps: steps.map(minus) };
}

module.exports = { evaluate, normalize, format, parse, solveEquation, solveSystem, unknowns, MathError };
