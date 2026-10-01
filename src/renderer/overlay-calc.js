'use strict';
// Scientific calculator inside the Math tool, for typing a problem instead of writing it.
// Answers come from the same exact engines as handwriting (never the AI model). Draggable.

(() => {
  const api = window.buddy;
  const $ = (id) => document.getElementById(id);
  const panel = $('calc');
  const input = $('calc-input');
  const result = $('calc-result');
  const working = $('calc-working');
  const toggle = $('math-calc-toggle');
  const history = $('calc-history');
  const POS_KEY = 'bigfoot.calc.pos';

  // A standard scientific layout. Each key: [label, inserted text, kind]; the 2nd key swaps a key
  // to its inverse [label2, insert2]. Kinds: num, op, fn, act (an action), go (calculate).
  const KEYS = [
    { id: '2nd', label: '2nd', kind: 'act' }, { id: 'angle', label: 'DEG', kind: 'act' },
    { label: 'sin', insert: 'sin(', alt: ['sin⁻¹', 'asin('], kind: 'fn' }, { label: 'cos', insert: 'cos(', alt: ['cos⁻¹', 'acos('], kind: 'fn' }, { label: 'tan', insert: 'tan(', alt: ['tan⁻¹', 'atan('], kind: 'fn' },
    { label: 'x²', insert: '^2', alt: ['x³', '^3'], kind: 'fn' }, { label: 'xʸ', insert: '^', kind: 'fn' }, { label: '√x', insert: 'sqrt(', alt: ['∛x', 'cbrt('], kind: 'fn' },
    { label: 'log', insert: 'log(', alt: ['10ˣ', '10^('], kind: 'fn' }, { label: 'ln', insert: 'ln(', alt: ['eˣ', 'e^('], kind: 'fn' },
    { label: '(', insert: '(', kind: 'op' }, { label: ')', insert: ')', kind: 'op' }, { label: 'n!', insert: '!', kind: 'fn' }, { label: 'π', insert: 'π', kind: 'fn' }, { label: 'e', insert: 'e', kind: 'fn' },
    { label: '7', insert: '7', kind: 'num' }, { label: '8', insert: '8', kind: 'num' }, { label: '9', insert: '9', kind: 'num' }, { label: '÷', insert: '÷', kind: 'op' }, { id: 'ac', label: 'AC', kind: 'act' },
    { label: '4', insert: '4', kind: 'num' }, { label: '5', insert: '5', kind: 'num' }, { label: '6', insert: '6', kind: 'num' }, { label: '×', insert: '×', kind: 'op' }, { id: 'del', label: '⌫', kind: 'act' },
    { label: '1', insert: '1', kind: 'num' }, { label: '2', insert: '2', kind: 'num' }, { label: '3', insert: '3', kind: 'num' }, { label: '−', insert: '−', kind: 'op' }, { label: 'Ans', insert: 'Ans', kind: 'fn' },
    { label: '0', insert: '0', kind: 'num' }, { label: '.', insert: '.', kind: 'num' }, { label: '×10ˣ', insert: '×10^(', kind: 'fn' }, { label: '+', insert: '+', kind: 'op' }, { id: 'go', label: '=', kind: 'go' },
    { label: 'x', insert: 'x', kind: 'alg' }, { label: 'y', insert: 'y', kind: 'alg' }, { label: 'a = b', insert: '=', kind: 'alg', title: 'Equation sign: type 2x+1=7 and press = to solve' },
    { label: 'd/dx', insert: 'd/dx ', kind: 'alg', title: 'Derivative, e.g. d/dx x^3' }, { label: '∫', insert: '∫', kind: 'alg', title: 'Integral, e.g. ∫x^2dx' },
  ];
  const keys = $('calc-keys');
  const buttons = new Map();
  let second = false;
  let angle = 'deg';
  try { angle = localStorage.getItem('bigfoot.calc.angle') === 'rad' ? 'rad' : 'deg'; } catch { /* default */ }

  for (const k of KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `calc-${k.kind}`;
    if (k.title) b.title = k.title;
    b.addEventListener('pointerdown', (e) => e.stopPropagation()); // never starts a pen stroke
    b.addEventListener('click', () => press(k));
    buttons.set(k, b);
    keys.append(b);
  }

  function renderKeys() {
    for (const [k, b] of buttons) {
      if (k.id === 'angle') b.textContent = angle === 'deg' ? 'DEG' : 'RAD';
      else b.textContent = second && k.alt ? k.alt[0] : k.label;
      if (k.id === '2nd') b.setAttribute('aria-pressed', String(second));
    }
    panel.querySelector('.calc-mode').textContent = angle === 'deg' ? 'degrees' : 'radians';
  }

  let last = null; // { text, answer, value, steps } of the last calculation

  function insertText(s) {
    input.setRangeText(s, input.selectionStart, input.selectionEnd, 'end');
  }

  function press(k) {
    if (k.id === '2nd') { second = !second; renderKeys(); }
    else if (k.id === 'angle') {
      angle = angle === 'deg' ? 'rad' : 'deg';
      try { localStorage.setItem('bigfoot.calc.angle', angle); } catch { /* not needed */ }
      renderKeys();
    } else if (k.id === 'ac') { input.value = ''; showResult(null); }
    else if (k.id === 'del') {
      const s = input.selectionStart;
      if (s !== input.selectionEnd) input.setRangeText('', s, input.selectionEnd, 'end');
      else if (s > 0) input.setRangeText('', s - 1, s, 'end');
    } else if (k.id === 'go') calculate();
    else {
      insertText(second && k.alt ? k.alt[1] : k.insert);
      if (second && k.alt) { second = false; renderKeys(); } // like a real calculator: 2nd applies once
    }
    input.focus();
  }
  renderKeys();

  function showResult(r) {
    working.textContent = '';
    if (!r) { result.textContent = ''; result.dataset.state = ''; return; }
    result.dataset.state = r.ok ? 'ok' : 'error';
    result.textContent = r.ok ? r.answer : r.message || 'I couldn’t work that out';
    for (const s of (r.ok && r.steps && r.steps.length > 1 ? r.steps : [])) {
      const li = document.createElement('li');
      li.textContent = s;
      working.append(li);
    }
  }

  async function calculate() {
    const text = input.value.trim();
    if (!text) return;
    if (/\bAns\b/.test(text) && !(last && last.value != null)) { showResult({ ok: false, message: 'There’s no previous answer yet' }); return; }
    // Ans is the previous answer, as a number in brackets so 2Ans and Ans² read correctly.
    const expr = text.replace(/\bAns\b/g, () => `(${last.value})`);
    result.dataset.state = 'busy';
    result.textContent = 'Working it out…';
    let r;
    try { r = await api.invoke('math:calc', expr, angle); } catch (err) { r = { ok: false, message: err.message }; }
    if (input.value.trim() !== text) return; // edited meanwhile
    if (r.ok) {
      const numeric = Number(String(r.answer).replace(/\s*≈.*$/, '').replace(/−/g, '-'));
      last = { text, answer: r.answer, value: Number.isFinite(numeric) ? numeric : (last && last.value), steps: r.steps || [] };
      history.textContent = `${text} =`;
    }
    showResult(r);
  }

  const ICON_COPY = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9.5" height="9.5" rx="1.8"/><path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6a1.5 1.5 0 0 0 1.5 1.5H7"/></svg>';
  const ICON_TICK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>';
  const copyBtn = $('calc-copy');
  copyBtn.innerHTML = ICON_COPY;

  async function copy() {
    if (!last) return;
    const lines = [last.text, `= ${last.answer}`];
    if (last.steps.length > 1) lines.push('', 'Working:', ...last.steps.map((s, i) => `${i + 1}. ${s}`));
    const res = await api.invoke('math:share', lines.join('\n')).catch(() => null);
    if (!(res && res.ok)) return;
    copyBtn.innerHTML = ICON_TICK; // copied: a tick for a moment, then the copy icon again
    copyBtn.classList.add('done');
    setTimeout(() => { copyBtn.innerHTML = ICON_COPY; copyBtn.classList.remove('done'); }, 1600);
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing here never triggers the math tool's own shortcuts
    if (e.key === 'Enter') { e.preventDefault(); calculate(); }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  });
  input.addEventListener('pointerdown', (e) => e.stopPropagation());

  // ---------------------------------------------------------------- open, close, drag
  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-pressed', String(open));
    if (open) { place(); setTimeout(() => input.focus(), 30); }
  }

  function place(pos) {
    let p = pos;
    if (!p) { try { p = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch { p = null; } }
    const w = panel.offsetWidth || 300;
    const h = panel.offsetHeight || 420;
    const x = p ? p.x : innerWidth - w - 24;
    const y = p ? p.y : 80;
    panel.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x))}px`;
    panel.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, y))}px`;
  }

  const head = $('calc-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    head.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, left: panel.offsetLeft, top: panel.offsetTop };
    const move = (ev) => place({ x: start.left + ev.clientX - start.x, y: start.top + ev.clientY - start.y });
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: panel.offsetLeft, y: panel.offsetTop })); } catch { /* not needed */ }
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
  panel.addEventListener('pointerdown', (e) => e.stopPropagation()); // the panel is not part of the writing area

  $('calc-copy').addEventListener('pointerdown', (e) => e.stopPropagation());
  $('calc-copy').addEventListener('click', copy);
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  $('calc-close').addEventListener('click', () => setOpen(false));
  // Closes with the math tool.
  api.on('ink', ({ active, mode }) => { if (active === false || (mode && mode !== 'math')) setOpen(false); });
})();
