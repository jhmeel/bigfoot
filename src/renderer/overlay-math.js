'use strict';
// Math tool: handwriting on the overlay, each separate expression answered as the user writes.

(() => {
  const api = window.buddy;
  const displayId = Number(new URLSearchParams(location.search).get('displayId'));
  const layer = document.getElementById('math-layer');
  const canvas = document.getElementById('math-ink');
  const answers = document.getElementById('math-answers');
  const g = canvas.getContext('2d');

  const PAUSE_MS = 900;       // read an expression this long after the pen lifts
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

  // ---------------------------------------------------------------- answers
  function answerEl(grp) {
    if (!grp.el) {
      grp.el = document.createElement('div');
      grp.el.className = 'math-answer';
      answers.append(grp.el);
    }
    const b = grp.box;
    const h = Math.max(28, Math.min(64, (b.y1 - b.y0) * 0.8));
    grp.el.style.left = `${b.x1 + 18}px`;
    grp.el.style.top = `${(b.y0 + b.y1) / 2}px`;
    grp.el.style.fontSize = `${h}px`;
    return grp.el;
  }

  function showAnswer(grp, { state, text = '', title = '' }) {
    const el = answerEl(grp);
    el.dataset.state = state;
    el.title = title;
    el.textContent = state === 'thinking' ? '' : text;
    requestAnimationFrame(() => el.classList.add('show'));
  }

  function removeGroup(grp) {
    clearTimeout(grp.timer);
    if (grp.el) grp.el.remove();
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

  async function read(grp) {
    const version = grp.version;
    showAnswer(grp, { state: 'thinking' });
    let res;
    try {
      res = await api.invoke('math:read', await snapshot(grp));
    } catch (err) {
      res = { ok: false, message: err.message };
    }
    if (!groups.includes(grp) || grp.version !== version) return; // more ink arrived meanwhile
    if (!res.ok) showAnswer(grp, { state: 'error', text: '!', title: res.message || 'Couldn’t read that' });
    else if (!res.answer) showAnswer(grp, { state: 'unknown', text: '?', title: res.expression ? `Read “${res.expression}”` : 'Couldn’t read that' });
    else showAnswer(grp, { state: 'done', text: /^[a-z]\s*=/i.test(res.answer) ? res.answer : `= ${res.answer}`, title: res.expression });
  }

  function schedule(grp) {
    grp.version++;
    clearTimeout(grp.timer);
    if (grp.el) grp.el.classList.remove('show');
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
    group.strokes.push(points);
    group.box = boxOf(group.strokes);
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

  document.getElementById('math-undo').addEventListener('click', undo);
  document.getElementById('math-clear').addEventListener('click', clearAll);
  document.getElementById('math-done').addEventListener('click', () => api.invoke('ink:stop'));
  window.addEventListener('keydown', (e) => {
    if (!active) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') clearAll();
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
