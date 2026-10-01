'use strict';
// MathML from Windows' Math Recognizer → the plain math the solvers read: x² → x^(2),
// fractions → (a)/(b), roots → sqrt(…), ∫ with limits → ∫(a,b) …, d/dx stays d/dx.

/** A tiny XML reader: enough for the recognizer's MathML (elements, text, entities). */
function parse(xml) {
  const root = { tag: '#root', children: [] };
  const stack = [root];
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      const text = decode(m[5]);
      if (text.trim()) top.children.push({ tag: '#text', text });
      continue;
    }
    if (m[2].startsWith('?') || m[2].startsWith('!')) continue;
    const tag = m[2].replace(/^.*:/, '').toLowerCase();
    if (m[1]) { // closing
      while (stack.length > 1 && stack.pop().tag !== tag) { /* tolerate sloppy nesting */ }
      continue;
    }
    const node = { tag, attrs: attrs(m[3]), children: [] };
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

function attrs(s) {
  const out = {};
  for (const a of String(s).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[a[1].replace(/^.*:/, '').toLowerCase()] = decode(a[2]);
  return out;
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
}

const OPERATORS = {
  '−': '-', '–': '-', '-': '-', '+': '+', '±': '+', '×': '*', '·': '*', '⋅': '*', '∗': '*', '*': '*', '÷': '/', '/': '/', '∕': '/',
  '=': '=', '(': '(', ')': ')', '[': '[', ']': ']', '{': '(', '}': ')', ',': ',', '!': '!', '%': '%', '|': '|', '.': '.',
  '⁢': '', '⁡': '', '⁣': ',', '∫': '∫', '∑': '∑', '√': 'sqrt',
};
const IDENTIFIERS = { 'π': 'pi', 'ⅇ': 'e', '∞': 'infinity' };

const text = (node) => node.children.map((c) => (c.tag === '#text' ? c.text : text(c))).join('');
const simple = (s) => /^[\w.]+$/.test(s) || /^\(.*\)$/.test(s);
const wrap = (s) => (simple(s) ? s : `(${s})`);

function convert(node) {
  const kids = node.children.filter((c) => c.tag !== '#text' || c.text.trim());
  const all = () => kids.map(convert).join('');
  switch (node.tag) {
    case '#root': case 'math': case 'mrow': case 'mstyle': case 'semantics': case 'mpadded': case 'mphantom': case 'menclose':
      return all();
    case '#text': return node.text.trim();
    case 'mn': return text(node).trim().replace(/,/g, '');
    case 'mi': { const t = text(node).trim(); return IDENTIFIERS[t] || t; }
    case 'mo': { const t = text(node).trim(); return t in OPERATORS ? OPERATORS[t] : t; }
    case 'mtext': return text(node).trim();
    case 'mspace': case 'annotation': case 'annotation-xml': return '';
    case 'msup': {
      const [base, exp] = kids.map(convert);
      return `${wrap(base)}^(${exp})`;
    }
    case 'msub': return convert(kids[0]); // x₁ is read as x
    case 'msubsup': case 'munderover': {
      const [base, low, high] = kids.map(convert);
      if (base === '∫') return `∫(${low},${high})`;
      if (base === '∑') return `∑(${low},${high})`;
      return `${wrap(base)}^(${high})`;
    }
    case 'munder': case 'mover': return convert(kids[0]);
    case 'mfrac': {
      const [num, den] = kids.map(convert);
      if (num === 'd' && /^d[a-z]$/i.test(den)) return `d/${den} `; // the derivative operator
      return `${wrap(num)}/${wrap(den)}`;
    }
    case 'msqrt': return `sqrt(${all()})`;
    case 'mroot': {
      const [base, index] = kids.map(convert);
      return `(${base})^(1/(${index}))`;
    }
    case 'mfenced': {
      const open = node.attrs.open != null ? node.attrs.open : '(';
      const close = node.attrs.close != null ? node.attrs.close : ')';
      const sep = node.attrs.separators != null ? node.attrs.separators || '' : ',';
      return `${open}${kids.map(convert).join(sep)}${close}`;
    }
    case 'mtable': case 'mtr': case 'mtd': return all();
    default: return all();
  }
}

/** @returns {string} plain math, "" if there's nothing */
function mathmlToText(xml) {
  if (!xml || !/<(?:\w+:)?math\b/i.test(xml)) return '';
  return convert(parse(xml)).replace(/\s+/g, ' ').trim();
}

module.exports = { mathmlToText, parse };
