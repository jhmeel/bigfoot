'use strict';
// Math tool: handwriting on the overlay, each separate expression read as it's written and solved
// (or checked, if the user wrote an answer) when the user presses Solve.

(() => {
  const api = window.buddy;
  const displayId = Number(new URLSearchParams(location.search).get('displayId'));
  const layer = document.getElementById('math-layer');
  const canvas = document.getElementById('math-ink');
  const answers = document.getElementById('math-answers');
  const g = canvas.getContext('2d');

  const PAUSE_MS = 200;       // read an expression this soon after the pen lifts
  const GROUP_GAP = 90;       // strokes closer than this belong to the same expression
  const INK = '#f5f7ff';
  const MAX_EDGE = 768;

  let active = false;
  let groups = [];
  let drawing = null;         // { group, points }
  let nextId = 1;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function strokePath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 1) ctx.lineTo(pts[0].x + 0.1, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    if (pts.length > 1) ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }

  function inkStyle(ctx) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = INK;
    ctx.shadowColor = 'rgba(51, 128, 255, 0.9)';
    ctx.shadowBlur = 6;
  }

  function redraw() {
    g.clearRect(0, 0, canvas.width, canvas.height);
    inkStyle(g);
    for (const grp of groups) for (const s of grp.strokes) strokePath(g, s);
    if (drawing) strokePath(g, drawing.points);
  }

  const boxOf = (strokes) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of strokes) for (const p of s) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x0, y0, x1, y1 };
  };

  function groupAt(p) {
    return groups.find((grp) => {
      const b = grp.box;
      return p.x > b.x0 - GROUP_GAP && p.x < b.x1 + GROUP_GAP * 1.6 && p.y > b.y0 - GROUP_GAP * 0.6 && p.y < b.y1 + GROUP_GAP * 0.6;
    });
  }

  /** On the same line and close enough that a sign between them joins them into one expression. */
  function sameLine(a, b) {
    const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
    return gap < GROUP_GAP * 1.6 && overlap > -GROUP_GAP * 0.4;
  }

  /** "0", then "100", then "×" between them: one expression, not three. */
  function joinNeighbours(grp) {
    for (let again = true; again;) {
      again = false;
      for (const other of groups) {
        if (other === grp || !sameLine(grp.box, other.box)) continue;
        grp.strokes = [...other.strokes, ...grp.strokes]; // the newest stroke stays last, for undo
        grp.box = boxOf(grp.strokes);
        removeGroup(other);
        again = true;
        break;
      }
    }
    groups = [...groups.filter((g) => g !== grp), grp]; // undo takes from the one just written
  }

  // ---------------------------------------------------------------- answers and live reading
  /**
   * Everything about one expression sits in a card just below it: what was read (with Solve and
   * Share), the answer, then the working. The card stays inside the screen: shifted left near the
   * right edge, moved above the writing near the bottom.
   */
  function place(grp) {
    if (!grp.card) {
      grp.card = document.createElement('div');
      grp.card.className = 'math-card';
      grp.el = document.createElement('div');
      grp.el.className = 'math-answer';
      grp.reading = document.createElement('div');
      grp.reading.className = 'math-reading';
      grp.working = document.createElement('ol');
      grp.working.className = 'math-working';
      grp.card.append(grp.reading, grp.el, grp.working);
      answers.append(grp.card);
    }
    const b = grp.box;
    grp.el.style.fontSize = `${Math.max(22, Math.min(40, (b.y1 - b.y0) * 0.6))}px`;
    grp.card.style.left = `${b.x0}px`;
    grp.card.style.top = `${b.y1 + 10}px`;
    requestAnimationFrame(() => keepOnScreen(grp));
  }

  function keepOnScreen(grp) {
    if (!grp.card) return;
    const b = grp.box;
    // Measure at its natural width: placed near the right edge it would already be squeezed.
    grp.card.style.left = '0px';
    const r = grp.card.getBoundingClientRect();
    const margin = 12;
    let left = b.x0;
    let top = b.y1 + 10;
    if (left + r.width > innerWidth - margin) left = Math.max(margin, innerWidth - margin - r.width);
    if (top + r.height > innerHeight - margin) top = Math.max(margin, b.y0 - 10 - r.height); // not enough room below
    grp.card.style.left = `${left}px`;
    grp.card.style.top = `${top}px`;
  }

  /** The working for heavy maths (equations, systems, calculus, vectors), step by step under it. */
  function showWorking(grp, steps) {
    place(grp);
    grp.working.textContent = '';
    const list = Array.isArray(steps) ? steps.filter(Boolean).slice(0, 16) : [];
    for (const s of list) {
      const li = document.createElement('li');
      li.textContent = s;
      grp.working.append(li);
    }
    grp.working.classList.toggle('show', list.length > 1);
    grp.steps = list;
    requestAnimationFrame(() => keepOnScreen(grp));
  }

  function showAnswer(grp, { state, text = '', title = '' }) {
    place(grp);
    const el = grp.el;
    el.dataset.state = state;
    el.title = title;
    el.textContent = state === 'thinking' ? '' : text;
    el.classList.toggle('show', Boolean(text) || state === 'thinking');
    grp.answer = state === 'done' || state === 'right' || state === 'wrong' ? (state === 'right' ? `${grp.readingText} ✓` : text) : '';
    if (grp.shareBtn) grp.shareBtn.hidden = !grp.answer;
    requestAnimationFrame(() => keepOnScreen(grp));
  }

  const button = (cls, label, onClick) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => e.stopPropagation()); // not the start of a stroke
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
    return b;
  };

  /** The problem, its answer, and the working, as text to paste anywhere. */
  async function share(grp, btn) {
    const lines = [grp.readingText, grp.answer && !grp.answer.endsWith('✓') ? `Answer: ${grp.answer}` : grp.answer];
    if (grp.steps && grp.steps.length > 1) lines.push('', 'Working:', ...grp.steps.map((s, i) => `${i + 1}. ${s}`));
    const res = await api.invoke('math:share', lines.filter((l) => l != null).join('\n')).catch(() => null);
    btn.textContent = res && res.ok ? 'Copied' : 'Couldn’t copy';
    setTimeout(() => { btn.textContent = 'Share'; }, 1800);
  }

  /** What the recognizer read, typeset under the handwriting with its Solve and Share buttons. */
  function showReading(grp, text) {
    place(grp);
    grp.reading.textContent = '';
    grp.readingText = text;
    if (text) {
      const label = document.createElement('span');
      label.textContent = text;
      grp.shareBtn = button('math-share', 'Share', (b) => share(grp, b));
      grp.shareBtn.title = 'Copy the problem, answer, and working to paste anywhere';
      grp.shareBtn.hidden = !grp.answer;
      grp.reading.append(label, button('math-solve', 'Solve', () => solve(grp)), grp.shareBtn);
    }
    grp.reading.classList.toggle('show', Boolean(text));
    requestAnimationFrame(() => keepOnScreen(grp));
  }

  function removeGroup(grp) {
    clearTimeout(grp.timer);
    if (grp.card) grp.card.remove();
    groups = groups.filter((x) => x !== grp);
  }

  // ---------------------------------------------------------------- reading
  async function snapshot(grp) {
    const b = grp.box;
    const pad = 24;
    const w = b.x1 - b.x0 + pad * 2;
    const h = b.y1 - b.y0 + pad * 2;
    const scale = Math.min(2, MAX_EDGE / Math.max(w, h));
    const off = new OffscreenCanvas(Math.max(32, Math.round(w * scale)), Math.max(32, Math.round(h * scale)));
    const c = off.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, off.width, off.height);
    c.setTransform(scale, 0, 0, scale, (pad - b.x0) * scale, (pad - b.y0) * scale);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = 3.5;
    c.strokeStyle = '#111111';
    for (const s of grp.strokes) strokePath(c, s);
    return (await off.convertToBlob({ type: 'image/png' })).arrayBuffer();
  }

  /**
   * Recognize the handwriting (Windows, ~0.1 s) and show the clean reading as the user writes.
   * Answers wait for Solve: "=" alone can't tell a sum from an equation.
   */
  async function read(grp) {
    const version = grp.version;
    let res;
    try {
      res = await api.invoke('math:ink', grp.strokes);
    } catch (err) {
      res = { ok: false, message: err.message };
    }
    if (!groups.includes(grp) || grp.version !== version) return; // more ink arrived meanwhile
    grp.result = res.ok ? res : null;
    if (!res.ok) { showReading(grp, ''); showAnswer(grp, { state: 'error', text: '!', title: res.message || 'Couldn’t read that' }); return; }
    showReading(grp, res.text || (grp.strokes.length ? '…' : ''));
  }

  /** Show the answer for one expression. Sums are exact; anything with a letter goes to the AI model. */
  async function solve(grp) {
    const version = grp.version;
    const res = grp.result;
    switch (res && res.status) {
      case 'writing':
      case 'answer': showAnswer(grp, { state: 'done', text: res.answer, title: res.expression }); return;
      case 'solved': {
        // Two lines like x + y = 5 and x − y = 1 are one problem: solve them together.
        const lines = groups.filter((g) => g.result && g.result.status === 'solved' && g.result.system);
        if (res.system && lines.length > 1) {
          const sys = await api.invoke('math:system', lines.map((g) => g.result.expression)).catch(() => null);
          if (sys && sys.ok) {
            lines.forEach((g) => { showAnswer(g, { state: 'done', text: sys.answer, title: 'Solved together' }); showWorking(g, null); });
            showWorking(lines[lines.length - 1], sys.steps);
            return;
          }
        }
        showAnswer(grp, { state: 'done', text: res.answer, title: res.expression });
        showWorking(grp, res.steps);
        return;
      }
      case 'right': showAnswer(grp, { state: 'right', text: '✓', title: 'Correct' }); return;
      case 'wrong': showAnswer(grp, { state: 'wrong', text: res.answer, title: `That's ${res.answer}, not ${res.given}` }); return;
      default: break;
    }
    showAnswer(grp, { state: 'thinking' });
    let ai;
    try {
      ai = await api.invoke('math:read', await snapshot(grp));
    } catch (err) {
      ai = { ok: false, message: err.message };
    }
    if (!groups.includes(grp) || grp.version !== version) return;
    if (!ai.ok || !ai.answer) showAnswer(grp, { state: 'unknown', text: '?', title: ai.message || 'Couldn’t solve that' });
    else { showAnswer(grp, { state: 'done', text: ai.answer.replace(/^=\s*/, ''), title: ai.expression }); showWorking(grp, ai.steps); }
  }

  function schedule(grp) {
    grp.version++;
    grp.result = null;
    clearTimeout(grp.timer);
    showAnswer(grp, { state: 'none' }); // the ink changed: the old answer no longer applies
    if (grp.working) showWorking(grp, null);
    grp.timer = setTimeout(() => read(grp), PAUSE_MS);
  }

  // ---------------------------------------------------------------- pen
  layer.addEventListener('pointerdown', (e) => {
    if (!active || e.button !== 0 || e.target.closest('.ink-bar')) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    const p = { x: e.clientX, y: e.clientY };
    let grp = groupAt(p);
    if (grp) clearTimeout(grp.timer);
    else {
      grp = { id: nextId++, strokes: [], box: { x0: p.x, y0: p.y, x1: p.x, y1: p.y }, version: 0, timer: null, el: null };
      groups.push(grp);
    }
    drawing = { group: grp, points: [p] };
  });

  layer.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const last = drawing.points[drawing.points.length - 1];
      if (Math.hypot(ev.clientX - last.x, ev.clientY - last.y) >= 1.5) drawing.points.push({ x: ev.clientX, y: ev.clientY });
    }
    redraw();
  });

  const endStroke = () => {
    if (!drawing) return;
    const { group, points } = drawing;
    drawing = null;
    // Double-tap on empty screen closes Math (a dot next to writing, as in ÷ or i, never does).
    const isTap = (s) => s.every((p) => Math.hypot(p.x - s[0].x, p.y - s[0].y) < 6);
    const nearInk = (p, r) => groups.some((g) => g.strokes.some((s) => !isTap(s) && s.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < r)));
    if (window.doubleTapExit(points, nearInk)) {
      for (const g of [...groups]) {
        g.strokes = g.strokes.filter((s) => !(isTap(s) && Math.hypot(s[0].x - points[0].x, s[0].y - points[0].y) < 20));
        if (!g.strokes.length) removeGroup(g);
        else g.box = boxOf(g.strokes);
      }
      redraw();
      return;
    }
    group.strokes.push(points);
    group.box = boxOf(group.strokes);
    joinNeighbours(group);
    redraw();
    schedule(group);
  };
  layer.addEventListener('pointerup', endStroke);
  layer.addEventListener('pointercancel', endStroke);

  // ---------------------------------------------------------------- controls
  function undo() {
    const grp = groups[groups.length - 1];
    if (!grp) return;
    grp.strokes.pop();
    if (!grp.strokes.length) removeGroup(grp);
    else { grp.box = boxOf(grp.strokes); schedule(grp); }
    redraw();
  }

  function clearAll() {
    [...groups].forEach(removeGroup);
    drawing = null;
    redraw();
  }

  document.getElementById('math-solve-all').addEventListener('click', () => groups.forEach(solve));
  document.getElementById('math-undo').addEventListener('click', undo);
  document.getElementById('math-clear').addEventListener('click', clearAll);
  document.getElementById('math-done').addEventListener('click', () => api.invoke('ink:stop'));
  window.addEventListener('keydown', (e) => {
    if (!active || e.target.closest('input, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') clearAll();
    if (e.key === 'Enter') groups.forEach(solve);
  });

  api.on('ink', ({ active: on, mode, displayId: target, clear }) => {
    if (clear) clearAll();
    if (mode !== undefined && mode !== 'math') on = false;
    if (target != null && target !== displayId) on = false;
    if (on === undefined) return;
    active = Boolean(on);
    document.body.classList.toggle('math', active);
    if (!active) clearAll();
  });

  window.addEventListener('resize', resize);
  resize();
})();
