'use strict';
// Draw tool: freehand ink and shapes on the screen, with a movable toolbar.

(() => {
  const api = window.buddy;
  const displayId = Number(new URLSearchParams(location.search).get('displayId'));
  const $ = (id) => document.getElementById(id);
  const layer = $('ink-layer');
  const bar = $('ink-bar');
  const cursor = $('ink-cursor');
  const baseCanvas = $('ink-base');
  const liveCanvas = $('ink-live');
  const base = baseCanvas.getContext('2d');
  const live = liveCanvas.getContext('2d');

  const COLORS = ['#ffffff', '#1c1c1e', '#ff453a', '#ff9f0a', '#ffd60a', '#32d74b', '#0a84ff', '#bf5af2'];
  const SIZES = [2, 4, 8, 14];
  const TOOLS = {
    pointer: { key: 'v' }, pen: { key: 'p' }, highlighter: { key: 'h' }, brush: { key: 'b' }, eraser: { key: 'e' },
    line: { key: 'l', shape: true }, arrow: { key: 'a', shape: true }, rect: { key: 'r', shape: true }, ellipse: { key: 'o', shape: true },
    text: { shape: true }, // added by the AI only
  };
  const PREFS_KEY = 'bigfoot.ink';

  let active = false;
  let prefs = { tool: 'pen', color: '#ff453a', size: 1, tidy: false, barX: null, barY: null };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { /* defaults */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* not needed */ } };

  let strokes = [];
  let undoStack = [];
  let redoStack = [];
  let current = null;
  let erased = null;

  // ---------------------------------------------------------------- canvas
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const [c, ctx] of [[baseCanvas, base], [liveCanvas, live]]) {
      c.width = Math.round(window.innerWidth * dpr);
      c.height = Math.round(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    redrawBase();
    placeBar();
  }

  const widthOf = (s) => {
    if (s.px) return s.px;
    const w = SIZES[s.size] || SIZES[1];
    return s.tool === 'highlighter' ? w * 3.2 + 6 : s.tool === 'brush' ? w * 2.4 + 4 : w;
  };

  function smoothPath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length < 3) {
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
      if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
      return;
    }
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  function arrowHead(ctx, a, b, w) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = Math.max(12, w * 3.6);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - len * Math.cos(ang - 0.45), b.y - len * Math.sin(ang - 0.45));
    ctx.lineTo(b.x - len * Math.cos(ang + 0.45), b.y - len * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
  }

  function drawStroke(ctx, s) {
    const w = widthOf(s);
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.tool === 'highlighter') {
      ctx.globalAlpha = 0.34;
      ctx.lineCap = 'square';
    } else if (s.tool === 'brush') {
      ctx.shadowColor = s.color;
      ctx.shadowBlur = w * 0.6;
    } else if (s.color !== '#1c1c1e') {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = 2;
    }
    const pts = s.points;
    if (s.tool === 'text') {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 3;
      ctx.font = `600 ${textSize(s)}px Inter, 'Segoe UI', sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(s.text || '', pts[0].x, pts[0].y);
    } else if (s.tool === 'pen' && s.pressure) {
      for (let i = 1; i < pts.length; i++) {
        ctx.beginPath();
        ctx.lineWidth = Math.max(1, w * (0.35 + (pts[i].p || 0.5) * 1.3));
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
    } else if (TOOLS[s.tool].shape) {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      ctx.beginPath();
      if (s.tool === 'line' || s.tool === 'arrow') {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        if (s.tool === 'arrow' && Math.hypot(b.x - a.x, b.y - a.y) > 4) arrowHead(ctx, a, b, w);
      } else if (s.tool === 'rect') {
        ctx.roundRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.min(8, w * 1.5));
        ctx.stroke();
      } else {
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (s.sharp) { // exact geometry: pictures, SVG, and tidied shapes
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (pts.length === 1 || (pts.length === 2 && Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) < 0.5)) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
      if (s.fill) {
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = s.fill;
        ctx.fill();
        ctx.restore();
      }
      if (!s.noStroke) ctx.stroke();
    } else {
      smoothPath(ctx, pts);
      ctx.stroke();
    }
    ctx.restore();
  }

  let reported = -1;
  function redrawBase() {
    base.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const s of strokes) drawStroke(base, s);
    if (strokes.length !== reported) {
      reported = strokes.length;
      api.send('ink:state', { count: reported });
    }
  }

  function redrawLive() {
    live.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (current) drawStroke(live, current);
  }

  // ---------------------------------------------------------------- hit testing (eraser)
  function distToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  const textSize = (s) => 14 + (s.size || 0) * 6;

  function outline(s) {
    const pts = s.points;
    if (s.tool === 'text') {
      base.font = `600 ${textSize(s)}px Inter, 'Segoe UI', sans-serif`;
      const w = base.measureText(s.text || '').width;
      const h = textSize(s) / 2;
      const [x, y] = [pts[0].x, pts[0].y];
      return [{ x, y: y - h }, { x: x + w, y: y - h }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y: y - h }];
    }
    if (!TOOLS[s.tool].shape) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    if (s.tool === 'line' || s.tool === 'arrow') return [a, b];
    if (s.tool === 'rect') return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    return Array.from({ length: 41 }, (_, i) => ({ x: cx + rx * Math.cos((i / 40) * Math.PI * 2), y: cy + ry * Math.sin((i / 40) * Math.PI * 2) }));
  }

  function hits(s, p, r) {
    const pts = outline(s);
    const reach = r + widthOf(s) / 2;
    if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= reach;
    for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1], pts[i]) <= reach) return true;
    return false;
  }

  function eraseAt(p) {
    const r = SIZES[prefs.size] * 1.5 + 6;
    const keep = strokes.filter((s) => !hits(s, p, r));
    if (keep.length !== strokes.length) { strokes = keep; redrawBase(); }
  }

  // ---------------------------------------------------------------- history
  function record(action) {
    undoStack.push(action);
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    renderBar();
  }

  function apply(action, reverse) {
    if (action.type === 'add') {
      if (reverse) strokes = strokes.filter((s) => s !== action.stroke);
      else strokes.push(action.stroke);
    } else if (action.type === 'erase' || action.type === 'ai') {
      strokes = (reverse ? action.before : action.after).slice();
    } else if (action.type === 'clear') {
      strokes = reverse ? action.strokes.slice() : [];
    }
    redrawBase();
  }

  function undo() {
    const a = undoStack.pop();
    if (!a) return;
    apply(a, true);
    redoStack.push(a);
    renderBar();
  }

  function redo() {
    const a = redoStack.pop();
    if (!a) return;
    apply(a, false);
    undoStack.push(a);
    renderBar();
  }

  function clearInk() {
    if (!strokes.length) return;
    record({ type: 'clear', strokes: strokes.slice() });
    strokes = [];
    redrawBase();
  }

  function reset() {
    strokes = [];
    undoStack = [];
    redoStack = [];
    current = null;
    redrawBase();
    redrawLive();
  }

  // ---------------------------------------------------------------- tidy: rough shapes become perfect ones
  function simplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    let far = 0;
    let at = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = distToSegment(pts[i], pts[0], pts[pts.length - 1]);
      if (d > far) { far = d; at = i; }
    }
    if (far <= eps) return [pts[0], pts[pts.length - 1]];
    return [...simplify(pts.slice(0, at + 1), eps).slice(0, -1), ...simplify(pts.slice(at), eps)];
  }

  const ring = (cx, cy, rx, ry) => Array.from({ length: 73 }, (_, i) => ({ x: cx + rx * Math.cos((i / 72) * Math.PI * 2), y: cy + ry * Math.sin((i / 72) * Math.PI * 2) }));

  /** The perfect version of a hand-drawn line, circle, ellipse, rectangle, triangle, or quadrilateral. */
  function recognize(pts) {
    if (pts.length < 4) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const w = x1 - x0;
    const h = y1 - y0;
    const size = Math.max(w, h);
    if (size < 16) return null;
    const a = pts[0];
    const b = pts[pts.length - 1];
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const bend = Math.max(...pts.map((p) => distToSegment(p, a, b)));
    if (chord > size * 0.8 && bend < Math.max(5, chord * 0.07)) return [a, b];
    if (chord > size * 0.3) return null; // open and curved: leave it as drawn

    // A few straight sides? (A circle simplifies to six or more.) Drop the extra vertex where the
    // stroke started mid-side.
    const v = simplify([...pts, a], Math.max(4, size * 0.08)).slice(0, -1);
    for (let again = true; again && v.length > 3;) {
      again = false;
      for (let i = 0; i < v.length; i++) {
        if (distToSegment(v[i], v[(i + v.length - 1) % v.length], v[(i + 1) % v.length]) < Math.max(4, size * 0.07)) { v.splice(i, 1); again = true; break; }
      }
    }
    if ((v.length === 3 || v.length === 4) && pts.every((p) => v.some((q, i) => distToSegment(p, q, v[(i + 1) % v.length]) < Math.max(5, size * 0.1)))) {
      const level = (p, q) => Math.min(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) < size * 0.12;
      if (v.length === 4 && v.every((q, i) => level(q, v[(i + 1) % 4]))) {
        return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }];
      }
      return [...v, v[0]];
    }

    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = w / 2;
    const ry = h / 2;
    const err = pts.reduce((n, p) => n + Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1), 0) / pts.length;
    const reach = Math.min(w, h) * 0.12 + 2; // a box's corners; a circle stays ~0.2 × its width away
    const boxy = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].every(([qx, qy]) => pts.some((p) => Math.hypot(p.x - qx, p.y - qy) < reach));
    if (boxy && err > 0.07) return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }];
    if (err < 0.09 + 1.5 / Math.min(rx, ry) && Math.min(w, h) > 8) {
      if (Math.abs(w - h) / size < 0.15) { const r = (w + h) / 4; return ring(cx, cy, r, r); }
      return ring(cx, cy, rx, ry);
    }
    return null;
  }

  function tidied(s) {
    if (!s || TOOLS[s.tool].shape || s.sharp || s.tool === 'eraser') return null;
    const pts = recognize(s.points);
    return pts ? { ...s, points: pts, sharp: true, pressure: false } : null;
  }

  // ---------------------------------------------------------------- pointer input
  function constrain(tool, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (tool === 'rect' || tool === 'ellipse') {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      return { x: a.x + Math.sign(dx || 1) * d, y: a.y + Math.sign(dy || 1) * d };
    }
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
  }

  layer.addEventListener('pointerdown', (e) => {
    if (!active || e.button !== 0 || prefs.tool === 'pointer' || bar.contains(e.target)) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    const p = { x: e.clientX, y: e.clientY, p: e.pressure || 0.5 };
    if (prefs.tool === 'eraser') {
      erased = { before: strokes.slice() };
      eraseAt(p);
      return;
    }
    current = { tool: prefs.tool, color: prefs.color, size: prefs.size, points: [p], pressure: e.pointerType === 'pen' };
    holdAt = p;
    armHold();
    redrawLive();
  });

  layer.addEventListener('pointermove', (e) => {
    moveCursor(e);
    if (erased) { for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) eraseAt({ x: ev.clientX, y: ev.clientY }); return; }
    if (!current) return;
    if (current.snapped) {
      // A pause snapped the shape, but the pen kept going: it was only a pause. Carry on drawing
      // the original stroke from where it was, as if the snap never happened.
      if (Math.hypot(e.clientX - holdAt.x, e.clientY - holdAt.y) <= 8) return;
      current = current.raw;
      redrawLive();
    }
    if (Math.hypot(e.clientX - holdAt.x, e.clientY - holdAt.y) > 4) { holdAt = { x: e.clientX, y: e.clientY }; armHold(); }
    if (TOOLS[current.tool].shape) {
      const b = { x: e.clientX, y: e.clientY };
      current.points = [current.points[0], e.shiftKey ? constrain(current.tool, current.points[0], b) : b];
    } else {
      for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) {
        const last = current.points[current.points.length - 1];
        if (Math.hypot(ev.clientX - last.x, ev.clientY - last.y) >= 1.2) current.points.push({ x: ev.clientX, y: ev.clientY, p: ev.pressure || 0.5 });
      }
    }
    redrawLive();
  });

  // Hold the pen still at the end of a stroke and it snaps to the shape you meant.
  let holdAt = null;
  let holdTimer = null;
  function armHold() {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      const t = tidied(current);
      if (t) { current = { ...t, snapped: true, raw: current }; redrawLive(); }
    }, 550);
  }

  function endStroke() {
    clearTimeout(holdTimer);
    if (erased) {
      if (erased.before.length !== strokes.length) record({ type: 'erase', before: erased.before, after: strokes.slice() });
      erased = null;
      return;
    }
    if (!current) return;
    let s = current;
    current = null;
    if (s.snapped) { delete s.snapped; delete s.raw; }
    else if (prefs.tidy) s = tidied(s) || s;
    redrawLive();
    const pts = s.points;
    // Double-tap on empty screen closes Draw: drop the dot the first tap left.
    const prev = strokes[strokes.length - 1];
    const tiny = (st) => st && !TOOLS[st.tool].shape && st.points.every((p) => Math.hypot(p.x - st.points[0].x, p.y - st.points[0].y) < 6);
    const prevIsTap = tiny(prev);
    if (window.doubleTapExit(pts, (p, r) => strokes.some((st) => !(prevIsTap && st === prev) && hits(st, p, r)))) {
      if (prevIsTap) {
        strokes.pop();
        const u = undoStack[undoStack.length - 1];
        if (u && u.type === 'add' && u.stroke === prev) undoStack.pop();
        redrawBase();
        renderBar();
      }
      return;
    }
    if (TOOLS[s.tool].shape && (pts.length < 2 || Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) < 3)) return;
    strokes.push(s);
    redrawBase();
    record({ type: 'add', stroke: s });
  }
  layer.addEventListener('pointerup', endStroke);
  layer.addEventListener('pointercancel', endStroke);

  // ---------------------------------------------------------------- cursor preview
  function moveCursor(e) {
    cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  }
  function renderCursor() {
    const t = prefs.tool;
    cursor.hidden = t === 'pointer';
    const d = t === 'eraser' ? (SIZES[prefs.size] * 1.5 + 6) * 2 : TOOLS[t].shape ? 10 : Math.max(6, widthOf({ tool: t, size: prefs.size }));
    cursor.style.width = cursor.style.height = `${d}px`;
    cursor.style.margin = `${-d / 2}px 0 0 ${-d / 2}px`;
    cursor.dataset.tool = t;
    cursor.style.setProperty('--c', prefs.color);
  }
  layer.addEventListener('pointerleave', () => { cursor.classList.add('away'); });
  layer.addEventListener('pointerenter', () => { cursor.classList.remove('away'); });

  // ---------------------------------------------------------------- toolbar
  const colorsEl = $('ink-colors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.setProperty('--c', c);
    b.title = 'Color';
    b.addEventListener('click', () => { prefs.color = c; if (['eraser', 'pointer'].includes(prefs.tool)) prefs.tool = 'pen'; changed(); });
    colorsEl.append(b);
  }
  const sizesEl = $('ink-sizes');
  SIZES.forEach((w, i) => {
    const b = document.createElement('button');
    b.className = 'size';
    b.dataset.size = String(i);
    b.title = ['Fine', 'Medium', 'Thick', 'Extra thick'][i];
    const dot = document.createElement('i');
    dot.style.width = dot.style.height = `${Math.min(16, 3 + w)}px`;
    b.append(dot);
    b.addEventListener('click', () => { prefs.size = i; if (prefs.tool === 'pointer') prefs.tool = 'pen'; changed(); });
    sizesEl.append(b);
  });
  bar.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('ink-undo').addEventListener('click', undo);
  $('ink-redo').addEventListener('click', redo);
  $('ink-clear').addEventListener('click', clearInk);
  $('ink-tidy').addEventListener('click', () => { prefs.tidy = !prefs.tidy; changed(); });

  // ---------------------------------------------------------------- share
  const shareMenu = $('ink-share-menu');
  const shareNote = $('ink-share-note');
  function toggleShare(open = shareMenu.hidden) {
    shareMenu.hidden = !open;
    $('ink-share').setAttribute('aria-expanded', String(open));
    if (open) shareNote.textContent = '';
  }
  async function share(kind) {
    shareNote.textContent = kind === 'copy' ? 'Copying…' : 'Saving…';
    shareMenu.hidden = false;
    let res;
    try { res = await api.invoke('ink:share', kind); } catch (err) { res = { ok: false, message: err.message }; }
    shareNote.textContent = res.message || (res.ok ? 'Done' : 'Couldn’t share it');
    shareNote.dataset.state = res.ok ? 'ok' : 'error';
    if (res.file) {
      const open = document.createElement('button');
      open.textContent = 'Show';
      open.addEventListener('click', () => api.invoke('ink:reveal', res.file));
      shareNote.append(' ', open);
    }
    setTimeout(() => { if (!shareMenu.matches(':hover')) toggleShare(false); }, 2600);
  }
  $('ink-share').addEventListener('click', (e) => { e.stopPropagation(); toggleShare(); });
  shareMenu.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); share(b.dataset.share); }));
  window.addEventListener('pointerdown', (e) => { if (!shareMenu.hidden && !e.target.closest('#ink-share-menu, #ink-share')) toggleShare(false); }, true);
  window.addEventListener('keydown', (e) => {
    if (active && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !e.target.closest('input, textarea')) { e.preventDefault(); share('copy'); }
  });
  $('ink-close').addEventListener('click', () => api.invoke('ink:stop'));

  function setTool(t) {
    prefs.tool = t;
    changed();
  }

  function changed() {
    savePrefs();
    renderBar();
    renderCursor();
    applyPassthrough();
  }

  function renderBar() {
    bar.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === prefs.tool)));
    colorsEl.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === prefs.color)));
    sizesEl.querySelectorAll('.size').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.size) === prefs.size)));
    sizesEl.style.setProperty('--c', prefs.color);
    $('ink-undo').disabled = !undoStack.length;
    $('ink-redo').disabled = !redoStack.length;
    $('ink-clear').disabled = !strokes.length;
    $('ink-tidy').setAttribute('aria-pressed', String(Boolean(prefs.tidy)));
  }

  // Pointer mode: ink stays up, clicks reach the apps below, the toolbar stays usable.
  let overBar = false;
  function applyPassthrough() {
    if (busy) return; // main keeps clicks going through while the AI works
    const through = active && prefs.tool === 'pointer';
    document.body.classList.toggle('ink-through', through);
    api.send('ink:passthrough', through && !overBar);
  }
  bar.addEventListener('mouseenter', () => { overBar = true; applyPassthrough(); });
  bar.addEventListener('mouseleave', () => { overBar = false; applyPassthrough(); });

  // Drag the toolbar by its grip.
  function placeBar() {
    const w = bar.offsetWidth || 600;
    const h = bar.offsetHeight || 44;
    const x = prefs.barX == null ? (window.innerWidth - w) / 2 : prefs.barX;
    const y = prefs.barY == null ? 16 : prefs.barY;
    bar.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x))}px`;
    bar.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, y))}px`;
  }
  $('ink-grip').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = bar.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => { prefs.barX = ev.clientX - dx; prefs.barY = ev.clientY - dy; placeBar(); };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      savePrefs();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  // ---------------------------------------------------------------- keyboard (the overlay has focus while drawing)
  window.addEventListener('keydown', (e) => {
    if (!active || e.target.closest('input, textarea')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'delete' || k === 'backspace') { clearInk(); return; }
    const tool = Object.keys(TOOLS).find((t) => TOOLS[t].key === k);
    if (tool) { setTool(tool); return; }
    if (k === 't') { prefs.tidy = !prefs.tidy; changed(); return; }
    const n = Number(e.key);
    if (n >= 1 && n <= COLORS.length) { prefs.color = COLORS[n - 1]; if (['eraser', 'pointer'].includes(prefs.tool)) prefs.tool = 'pen'; changed(); }
    if (e.key === '[' || e.key === ']') { prefs.size = Math.max(0, Math.min(SIZES.length - 1, prefs.size + (e.key === ']' ? 1 : -1))); changed(); }
  });

  // ---------------------------------------------------------------- the AI and the drawing
  function aiEdit(fn) {
    const before = strokes.slice();
    const result = fn();
    if (strokes.length !== before.length || strokes.some((s, i) => s !== before[i])) {
      record({ type: 'ai', before, after: strokes.slice() });
      redrawBase();
    }
    return result;
  }

  async function handleOp(msg) {
    switch (msg.op) {
      case 'snapshot': {
        if (!strokes.length) return null;
        const blob = await new Promise((r) => baseCanvas.toBlob(r, 'image/png'));
        return blob ? blob.arrayBuffer() : null;
      }
      case 'add': {
        const list = (Array.isArray(msg.strokes) ? msg.strokes : [msg.stroke]).filter((s) => s && TOOLS[s.tool] && Array.isArray(s.points) && s.points.length);
        return aiEdit(() => { for (const s of list) strokes.push({ ...s, pressure: false }); return list.length; });
      }
      case 'strokes': // the drawing as data, for SVG export (the AI's "read", Share › SVG)
        return strokes.map(({ tool, color, size, points, text, fill, px, sharp, noStroke }) => ({ tool, color, size, points: points.map(({ x, y }) => ({ x, y })), text, fill, px, sharp, noStroke }));
      case 'replace': {
        const list = (Array.isArray(msg.strokes) ? msg.strokes : []).filter((s) => s && TOOLS[s.tool] && Array.isArray(s.points) && s.points.length);
        return aiEdit(() => { strokes = list.map((s) => ({ ...s, pressure: false })); return list.length; });
      }
      case 'tidy':
        return aiEdit(() => {
          const r = msg.rect;
          const within = (s) => !r || s.points.some((p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1);
          let n = 0;
          strokes = strokes.map((s) => { const t = within(s) && tidied(s); if (t) n++; return t || s; });
          return n;
        });
      case 'erase':
        return aiEdit(() => {
          const { x0, y0, x1, y1 } = msg.rect;
          const inside = (p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
          const center = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
          const reach = Math.hypot(x1 - x0, y1 - y0) / 2;
          const keep = strokes.filter((s) => !(outline(s).some(inside) || hits(s, center, reach * 0.5)));
          const removed = strokes.length - keep.length;
          strokes = keep;
          return removed;
        });
      case 'clear':
        return aiEdit(() => { const n = strokes.length; strokes = []; return n; });
      default:
        return null;
    }
  }

  // Talk works exactly like the tray's Talk; the drawing is part of what the AI sees.
  let busy = false;
  let talking = false;
  $('ink-talk').addEventListener('click', () => api.invoke('toolbar:pick', 'talk'));
  api.on('state', (s) => bar.classList.toggle('listening', s === 'listening'));
  api.on('voice-mode', (on) => { talking = Boolean(on); $('ink-talk').setAttribute('aria-pressed', String(talking)); renderTalkTitle(); });
  function renderTalkTitle() {
    $('ink-talk').title = busy ? 'Working on it… press Esc to stop'
      : talking ? 'Stop talking' : 'Talk: ask about your drawing, e.g. “neaten my circle”. Stays on until you stop it.';
  }

  function setBusy(on) {
    busy = on;
    bar.classList.toggle('busy', on);
    renderTalkTitle();
    if (!on) applyPassthrough();
  }

  api.on('ink', (msg) => {
    if (msg.displayId != null && msg.displayId !== displayId) {
      if (msg.active !== undefined) setActive(false);
      return;
    }
    if (msg.op) {
      Promise.resolve(handleOp(msg)).catch(() => null).then((result) => api.send('ink:reply', { id: msg.id, result }));
      return;
    }
    if (msg.clear) reset();
    if (msg.busy !== undefined) setBusy(Boolean(msg.busy));
    if (msg.active === undefined) return;
    const on = Boolean(msg.active) && msg.mode === 'draw';
    if (on) {
      // An explicit tool (the AI opens in pointer mode) isn't saved as the user's choice;
      // opening Draw yourself never starts in pointer mode.
      if (msg.tool && TOOLS[msg.tool]) prefs.tool = msg.tool;
      else if (prefs.tool === 'pointer') prefs.tool = 'pen';
      renderBar();
      renderCursor();
      if (active) applyPassthrough();
    }
    setActive(on);
  });

  function setActive(on) {
    const was = active;
    active = on;
    document.body.classList.toggle('ink', active);
    if (active && !was) requestAnimationFrame(() => { placeBar(); renderBar(); renderCursor(); applyPassthrough(); });
    if (!active && was) {
      reset();
      setBusy(false);
      document.body.classList.remove('ink-through');
    }
  }

  window.addEventListener('resize', resize);
  resize();
  renderBar();
  renderCursor();
})();
