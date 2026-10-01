'use strict';
// On-screen drawing (Claude's annotate tool) and the user's drag-to-highlight area selection.

(() => {
  const api = window.buddy;
  const params = new URLSearchParams(location.search);
  const displayId = Number(params.get('displayId'));
  const NS = 'http://www.w3.org/2000/svg';
  const COLORS = { blue: '#3380ff', red: '#ff5a5f', green: '#34d399', yellow: '#ffc53d', white: '#ffffff' };

  const svg = document.getElementById('draw');
  const labels = document.getElementById('labels');
  const defs = document.createElementNS(NS, 'defs');
  svg.append(defs);

  const el = (tag, attrs = {}, parent = svg) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent.append(n);
    return n;
  };

  // one arrowhead marker per color
  for (const [name, color] of Object.entries(COLORS)) {
    const m = el('marker', { id: `head-${name}`, viewBox: '0 0 12 12', refX: '9', refY: '6', markerWidth: '12', markerHeight: '12', markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, defs);
    el('path', { d: 'M1,1.5 L10,6 L1,10.5 Q3,6 1,1.5 Z', fill: color }, m);
  }

  /** Stroke draw-on animation, like a pen tracing the shape. */
  function drawOn(node, ms = 550) {
    const len = node.getTotalLength ? node.getTotalLength() : 0;
    if (!len) return;
    node.style.strokeDasharray = `${len}`;
    node.style.strokeDashoffset = `${len}`;
    node.getBoundingClientRect();
    node.style.transition = `stroke-dashoffset ${ms}ms cubic-bezier(0.65, 0, 0.35, 1)`;
    node.style.strokeDashoffset = '0';
  }

  function smoothPath(pts) {
    if (pts.length < 3) return `M${pts.map((p) => `${p.x},${p.y}`).join(' L')}`;
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) { // Catmull-Rom to cubic Bezier
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ` C${p1.x + (p2.x - p0.x) / 6},${p1.y + (p2.y - p0.y) / 6} ${p2.x - (p3.x - p1.x) / 6},${p2.y - (p3.y - p1.y) / 6} ${p2.x},${p2.y}`;
    }
    return d;
  }

  function addLabel(text, x, y, color, anchor = 'above') {
    if (!text) return null;
    const chip = document.createElement('div');
    chip.className = 'draw-label';
    chip.textContent = text;
    chip.style.setProperty('--c', color);
    labels.append(chip);
    const w = chip.offsetWidth, h = chip.offsetHeight;
    let left = x, top = anchor === 'above' ? y - h - 8 : anchor === 'center' ? y - h / 2 : y + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    if (top < 8) top = y + 8;
    top = Math.min(top, window.innerHeight - h - 8);
    chip.style.left = `${left}px`;
    chip.style.top = `${top}px`;
    requestAnimationFrame(() => chip.classList.add('show'));
    return chip;
  }

  function annotate(a) {
    if (a.displayId != null && a.displayId !== displayId) return;
    if (a.shape === 'clear') { clearAll(); return; }
    const color = COLORS[a.color] || COLORS.blue;
    const pts = a.points || [];
    const g = el('g', { class: 'drawing' });
    g.style.setProperty('--c', color);
    const nodes = [];
    let chip = null;
    const box = () => {
      const [p, q] = pts;
      const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y);
      return { x, y, w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
    };

    switch (a.shape) {
      case 'box': {
        const b = box();
        const pad = 4;
        el('rect', { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, rx: 8, class: 'fill' }, g);
        nodes.push(el('rect', { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, rx: 8, class: 'stroke' }, g));
        chip = addLabel(a.label, b.x - pad, b.y - pad, color, 'above');
        break;
      }
      case 'spotlight': {
        const b = box();
        const pad = 6;
        const id = `hole-${Math.random().toString(36).slice(2)}`;
        const mask = el('mask', { id }, defs);
        el('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: '#fff' }, mask);
        el('rect', { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, rx: 10, fill: '#000' }, mask);
        el('rect', { x: 0, y: 0, width: '100%', height: '100%', class: 'dim', mask: `url(#${id})` }, g);
        nodes.push(el('rect', { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, rx: 10, class: 'stroke' }, g));
        g._mask = mask;
        chip = addLabel(a.label, b.x - pad, b.y - pad, color, 'above');
        break;
      }
      case 'circle': {
        const b = box();
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        const rx = b.w / 2 + 10, ry = b.h / 2 + 10;
        // a hand-drawn loop that overshoots its start, like circling something with a pen
        const loop = [];
        for (let i = 0; i <= 44; i++) {
          const t = (i / 40) * Math.PI * 2 - Math.PI * 0.6;
          const wobble = 1 + Math.sin(i * 1.7) * 0.025;
          loop.push({ x: cx + Math.cos(t) * rx * wobble, y: cy + Math.sin(t) * ry * wobble });
        }
        nodes.push(el('path', { d: smoothPath(loop), class: 'stroke' }, g));
        chip = addLabel(a.label, b.x + b.w + 14, cy, color, 'center');
        break;
      }
      case 'arrow':
      case 'line': {
        const [p, q] = pts;
        // gentle curve so arrows read as drawn, not ruled
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
        const len = Math.hypot(q.x - p.x, q.y - p.y);
        const bend = a.shape === 'arrow' ? Math.min(len * 0.12, 40) : 0;
        const nx = -(q.y - p.y) / (len || 1), ny = (q.x - p.x) / (len || 1);
        const d = `M${p.x},${p.y} Q${mx + nx * bend},${my + ny * bend} ${q.x},${q.y}`;
        const attrs = { d, class: 'stroke' };
        if (a.shape === 'arrow') attrs['marker-end'] = `url(#head-${a.color in COLORS ? a.color : 'blue'})`;
        nodes.push(el('path', attrs, g));
        chip = addLabel(a.label, p.x, p.y, color, q.y > p.y ? 'above' : 'below');
        break;
      }
      case 'path': {
        nodes.push(el('path', { d: smoothPath(pts), class: 'stroke' }, g));
        chip = addLabel(a.label, pts[0].x, pts[0].y, color, 'above');
        break;
      }
      case 'text': {
        chip = addLabel(a.label, pts[0].x, pts[0].y, color, 'center');
        if (chip) chip.classList.add('solo');
        break;
      }
      default:
        g.remove();
        return;
    }
    nodes.forEach((n, i) => setTimeout(() => drawOn(n, a.shape === 'path' ? 900 : 550), i * 80));
    requestAnimationFrame(() => g.classList.add('show'));
    const item = { g, chip };
    items.push(item);
    item.timer = setTimeout(() => remove(item), (a.duration || 8) * 1000);
  }

  const items = [];
  function remove(item) {
    clearTimeout(item.timer);
    item.g.classList.remove('show');
    if (item.chip) item.chip.classList.remove('show');
    setTimeout(() => {
      item.g.remove();
      if (item.g._mask) item.g._mask.remove();
      if (item.chip) item.chip.remove();
    }, 400);
    const i = items.indexOf(item);
    if (i >= 0) items.splice(i, 1);
  }
  function clearAll() { [...items].forEach(remove); }

  // ------------------------------------------------------------------ lasso selection
  // The user drags to trace around something; a glowing line follows the cursor, then closes into
  // a softly filled outline. Its bounding box and points go to the main process for recognition.
  const layer = document.getElementById('select-layer');
  const lasso = el('g', { class: 'lasso' });
  const lassoFill = el('path', { class: 'lasso-fill' }, lasso);
  const lassoLine = el('path', { class: 'lasso-line' }, lasso);
  const lassoScan = el('path', { class: 'lasso-scan' }, lasso);
  const MIN_STEP = 3;   // px between recorded points
  const MIN_SIZE = 12;  // smaller traces are treated as a click, not a selection
  const MAX_POINTS = 200;
  let active = false;
  let tracing = null;   // points while the mouse is down

  function boundsOf(pts) {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  function rectPoints(r) {
    return [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }];
  }

  function thin(pts) {
    const step = Math.ceil(pts.length / MAX_POINTS);
    return pts.filter((_, i) => i % step === 0);
  }

  function showLasso(points, { closed = false, analyzing = false } = {}) {
    if (!points || points.length < 2) {
      lasso.setAttribute('class', 'lasso');
      return;
    }
    const d = smoothPath(points) + (closed ? ' Z' : '');
    lassoLine.setAttribute('d', d);
    lassoFill.setAttribute('d', closed ? d : '');
    lassoScan.setAttribute('d', analyzing ? d : '');
    const cls = ['lasso', 'show'];
    if (closed) cls.push('closed');
    if (analyzing) cls.push('analyzing');
    lasso.setAttribute('class', cls.join(' '));
  }

  layer.addEventListener('mousedown', (e) => {
    if (!active || e.button !== 0) return;
    e.preventDefault();
    tracing = [{ x: e.clientX, y: e.clientY }];
    showLasso(null);
  });

  window.addEventListener('mousemove', (e) => {
    if (!tracing) return;
    const last = tracing[tracing.length - 1];
    if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < MIN_STEP) return;
    tracing.push({ x: e.clientX, y: e.clientY });
    showLasso(tracing);
  });

  window.addEventListener('mouseup', () => {
    if (!tracing) return;
    const pts = tracing;
    tracing = null;
    const box = boundsOf(pts);
    if (pts.length < 3 || (box.width < MIN_SIZE && box.height < MIN_SIZE)) {
      showLasso(null);
      if (window.doubleTapExit(pts, () => false)) showAsk(null); // double-click cancels Point
      return;
    }
    // A nearly straight stroke can't enclose anything, so use the rectangle it spans.
    const outline = box.width < MIN_SIZE || box.height < MIN_SIZE ? rectPoints(box) : thin(pts);
    showLasso(outline, { closed: true });
    api.send('overlay:region', { ...boundsOf(outline), points: outline });
  });

  api.on('select', ({ active: on }) => {
    active = on;
    document.body.classList.toggle('selecting', on);
    if (!on && tracing) {
      tracing = null;
      showLasso(null);
    }
  });

  // ---------------------------------------------------------------- asking about the marked area
  const askForm = document.getElementById('region-ask');
  const askInput = document.getElementById('region-ask-input');

  function showAsk(r) {
    if (!r) { askForm.hidden = true; askInput.value = ''; return; }
    const W = Math.min(340, innerWidth - 32);
    const below = r.y + r.height + 12;
    const top = below + 44 < innerHeight ? below : Math.max(12, r.y - 56);
    askForm.style.left = `${Math.max(16, Math.min(r.x + r.width / 2 - W / 2, innerWidth - W - 16))}px`;
    askForm.style.top = `${top}px`;
    askInput.placeholder = r.voice ? 'Say or type your question…' : 'Ask about this area…';
    askForm.hidden = false;
    setTimeout(() => askInput.focus(), 30);
  }

  askForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = askInput.value.trim();
    if (!text) return;
    askForm.hidden = true;
    askInput.value = '';
    api.send('overlay:region-ask', text);
  });
  askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); showAsk(null); api.send('overlay:region-ask', ''); }
  });
  document.getElementById('region-ask-close').addEventListener('click', () => { showAsk(null); api.send('overlay:region-ask', ''); });
  // Clicking elsewhere with nothing typed means never mind (in Talk mode the question may still be spoken).
  let shownAt = 0;
  new MutationObserver(() => { if (!askForm.hidden) shownAt = Date.now(); }).observe(askForm, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('blur', () => {
    if (askForm.hidden || askInput.value.trim() || askInput.placeholder.startsWith('Say') || Date.now() - shownAt < 800) return;
    showAsk(null);
    api.send('overlay:region-ask', '');
  });

  api.on('region', (r) => {
    if (!r || (r.displayId != null && r.displayId !== displayId)) {
      showLasso(null);
      showAsk(null);
      return;
    }
    const pts = r.points && r.points.length > 2 ? r.points : rectPoints(r);
    showLasso(pts, { closed: true, analyzing: Boolean(r.analyzing) });
    showAsk(r.ask ? r : null);
  });
  api.on('annotate', annotate);
})();
