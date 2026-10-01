'use strict';
// LaTeX from the handwritten-math reader → the plain math the solvers read, the same notation
// as ./mathml: x^{2} → x^(2), \frac{a}{b} → (a)/(b), \sqrt{…} → sqrt(…), \int_a^b → ∫(a,b),
// \frac{d}{dx} → d/dx. The reader spaces every symbol ("1 1" is 11), so spaces mean nothing.

const NAMES = {
  times: '*', cdot: '*', ast: '*', div: '/', pm: '+', mp: '-', neq: '≠', ne: '≠', leq: '<=', le: '<=', geq: '>=', ge: '>=',
  pi: 'pi', infty: 'infinity', int: '∫', sum: '∑', prod: '∏', lt: '<', gt: '>', '{': '(', '}': ')', '|': '|',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', phi: 'φ', omega: 'ω',
  varepsilon: 'ε', epsilon: 'ε', varphi: 'φ', Delta: 'Δ', to: '->',
  mid: '1', vert: '1', // a handwritten 1 is a plain upright stroke
  lor: 'sqrt', vee: 'sqrt', surd: 'sqrt', // a handwritten √ without its top bar
  ',': '', ';': '', ':': '', '!': '', quad: '', qquad: '', left: '', right: '', big: '', Big: '', bigg: '', Bigg: '',
  displaystyle: '', textstyle: '', scriptstyle: '', scriptsize: '', limits: '', nolimits: '', prime: "'",
};
const FUNCS = /^(?:sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sinh|cosh|tanh|log|ln|lg|exp|lim|max|min|det)$/;
const WRAPPERS = /^(?:mathrm|mathit|mathbf|mathsf|text|textrm|textit|operatorname|boldsymbol|mathbb|bm|underline|overline|hat|bar|vec|tilde|widehat|widetilde|dot|check)$/;

function tokenize(latex) {
  const out = [];
  const s = String(latex || '');
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/\s|~/.test(c)) { i++; continue; }
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      if (!m) { i++; continue; }
      out.push({ cmd: m[1] });
      i += m[0].length;
      continue;
    }
    out.push({ ch: c });
    i++;
  }
  return out;
}

const simple = (s) => /^[\w.]+$/.test(s) || /^\((?:[^()]|\([^()]*\))*\)$/.test(s);
const wrap = (s) => (simple(s) ? s : `(${s})`);

function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];

  /** One argument: {…} or a single symbol. */
  function arg() {
    const t = tokens[i];
    if (!t) return '';
    if (t.ch === '{') { i++; return seq('}'); }
    i++;
    return atom(t);
  }

  function atom(t) {
    if (t.ch !== undefined) return t.ch === '{' ? seq('}') : t.ch === '[' ? '[' : t.ch;
    const c = t.cmd;
    if (c === 'frac' || c === 'dfrac' || c === 'tfrac') {
      const num = arg();
      const den = arg();
      if (num === 'd' && /^d[a-z]$/i.test(den)) return `d/${den} `;
      return `${wrap(num)}/${wrap(den)}`;
    }
    if (c === 'sqrt') {
      let index = '';
      if (peek() && peek().ch === '[') {
        i++;
        while (peek() && peek().ch !== ']') index += atom(tokens[i++]);
        i++;
      }
      const body = arg();
      return index ? `(${body})^(1/(${index}))` : `sqrt(${body})`;
    }
    if (c === 'begin' || c === 'end') {
      const env = arg();
      if (c === 'begin' && /array|tabular/.test(env) && peek() && peek().ch === '{') arg(); // column layout
      return ' ';
    }
    if (c === '\\') return ' ; ';
    if (WRAPPERS.test(c)) return arg();
    if (FUNCS.test(c)) return `${c} `;
    if (c in NAMES) return NAMES[c];
    if (peek() && peek().ch === '{') return arg(); // an unknown style (\textsc{x}): keep what it styles
    return c; // an unknown symbol: its name is the best guess
  }

  /** Symbols up to the closing brace, with ^ and _ attached to what precedes them. */
  function seq(close) {
    const parts = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (close && t.ch === close) { i++; break; }
      i++;
      if (t.ch === '^') {
        const exp = arg();
        const base = parts.pop() || '';
        if (base === '∫' || base === '∑') parts.push(`${base}(,${exp})`);
        else if (/^[∫∑]\(.*,\)$/.test(base)) parts.push(base.replace(/,\)$/, `,${exp})`));
        else parts.push(`${base}^(${exp})`);
        continue;
      }
      if (t.ch === '_') {
        const low = arg();
        const base = parts.pop() || '';
        if (base === '∫' || base === '∑') parts.push(`${base}(${low},)`);
        else if (/^[∫∑]\(,.*\)$/.test(base)) parts.push(base.replace(/^([∫∑])\(,/, `$1(${low},`));
        else parts.push(base); // x₁ is read as x
        continue;
      }
      parts.push(atom(t));
    }
    return parts.join('');
  }

  return seq(null);
}

/**
 * Handwritten x and × look alike, and the reader often writes \times for the letter. A × needs
 * something to multiply on both sides; "5 × +6" or "× ^2" can only be the letter, and so can a
 * number followed by a letter ("5 × y" is 5xy as written in algebra).
 */
function letterX(tokens) {
  const operand = (t) => t && (t.ch !== undefined ? /[\w.)}|]/.test(t.ch) : /^(?:pi|infty|right)$/.test(t.cmd));
  const starts = (t) => t && (t.ch !== undefined ? /[\w.({|]/.test(t.ch) : !/^(?:times|cdot|div|pm|mp)$/.test(t.cmd) && !/^[,;:!]$/.test(t.cmd));
  return tokens.map((t, k) => {
    if (t.cmd !== 'times') return t;
    const before = tokens[k - 1];
    const after = tokens[k + 1];
    if (!operand(before) || !starts(after)) return { ch: 'x' };
    if (before.ch && /\d/.test(before.ch) && after.ch && /[a-z]/i.test(after.ch)) return { ch: 'x' };
    return t;
  });
}

/** @returns {string} plain math, "" if there's nothing */
function latexToText(latex) {
  let tokens = letterX(tokenize(latex));
  // One upright bar on its own is a 1 too; two are an absolute value |x|.
  if (tokens.filter((t) => t.ch === '|').length === 1) tokens = tokens.map((t) => (t.ch === '|' ? { ch: '1' } : t));
  if (!tokens.length) return '';
  return parse(tokens).replace(/\s*;\s*$/, '').replace(/\s+/g, ' ').trim();
}

module.exports = { latexToText };
