'use strict';
// SVG shapes → ink strokes. Curves are sampled into points so the drawing stays ordinary ink
// (undo, eraser, and the model's screenshots all work on it).

const { svgPathProperties } = require('svg-path-properties');

const MAX_STROKES = 300;
const MAX_POINTS = 20000;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[3] ?? m[4];
  const style = out.style;
  if (style) {
    for (const part of style.split(';')) {
      const [k, v] = part.split(':').map((x) => x && x.trim());
      if (k && v) out[k.toLowerCase()] = v;
    }
  }
  return out;
}

const pointsAttr = (s) => (String(s || '').match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);

/** Any basic SVG element as path data. */
function toPathData(name, a) {
  switch (name) {
    case 'path': return a.d || '';
    case 'line': return `M${num(a.x1)} ${num(a.y1)}L${num(a.x2)} ${num(a.y2)}`;
    case 'polyline':
    case 'polygon': {
      const p = pointsAttr(a.points);
      if (p.length < 4) return '';
      let d = `M${p[0]} ${p[1]}`;
      for (let i = 2; i + 1 < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
      return name === 'polygon' ? `${d}Z` : d;
    }
    case 'circle':
    case 'ellipse': {
      const cx = num(a.cx);
      const cy = num(a.cy);
      const rx = name === 'circle' ? num(a.r) : num(a.rx);
      const ry = name === 'circle' ? num(a.r) : num(a.ry, rx);
      if (!(rx > 0 && ry > 0)) return '';
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`;
    }
    case 'rect': {
      const x = num(a.x);
      const y = num(a.y);
      const w = num(a.width);
      const h = num(a.height);
      if (!(w > 0 && h > 0)) return '';
      const r = Math.min(num(a.rx, num(a.ry)), w / 2, h / 2);
      if (!(r > 0)) return `M${x} ${y}h${w}v${h}h${-w}Z`;
      return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
    }
    default: return '';
  }
}

/**
 * Parse SVG markup (or a bare list of elements).
 * @returns {{ viewBox: number[]|null, shapes: { d, stroke, fill, width }[] }}
 */
function parseSvg(markup) {
  const src = String(markup || '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<(script|foreignobject|image|use)\b/i.test(src)) throw new Error('Only plain shapes are supported: path, line, polyline, polygon, circle, ellipse, rect.');
  const root = /<svg\b[^>]*>/i.exec(src);
  const top = root ? attrs(root[0]) : {};
  const vb = pointsAttr(top.viewbox);
  const viewBox = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb
    : num(top.width) > 0 && num(top.height) > 0 ? [0, 0, num(top.width), num(top.height)] : null;
  const groups = [];
  const shapes = [];
  for (const m of src.matchAll(/<\s*(\/?)\s*(g|path|line|polyline|polygon|circle|ellipse|rect)\b([^>]*?)(\/?)>/gi)) {
    const name = m[2].toLowerCase();
    if (name === 'g') {
      if (m[1]) groups.pop();
      else if (!m[4]) groups.push(attrs(m[3]));
      continue;
    }
    if (m[1]) continue;
    const a = { ...top, ...Object.assign({}, ...groups), ...attrs(m[3]) };
    const d = toPathData(name, a);
    if (!d) continue;
    shapes.push({ d, stroke: a.stroke, fill: a.fill, width: a['stroke-width'] != null ? num(a['stroke-width'], null) : null });
  }
  if (!shapes.length) throw new Error('The SVG has no shapes. Use path, line, polyline, polygon, circle, ellipse, or rect elements.');
  return { viewBox, shapes };
}

/** Sample path data into polylines (one per subpath) in its own coordinates. */
function samplePath(d, step) {
  let parts;
  try { parts = new svgPathProperties(d).getParts(); } catch (err) { throw new Error(`Bad path data "${String(d).slice(0, 40)}": ${err.message}`); }
  const lines = [];
  let cur = null;
  for (const part of parts) {
    const start = part.start;
    if (!cur || Math.hypot(start.x - cur.at.x, start.y - cur.at.y) > 1e-6) {
      cur = { pts: [{ x: start.x, y: start.y }], at: start };
      lines.push(cur);
    }
    const n = Math.max(1, Math.min(400, Math.ceil(part.length / step)));
    const straight = part.length > 0 && Math.abs(Math.hypot(part.end.x - start.x, part.end.y - start.y) - part.length) < part.length * 1e-4;
    for (let i = straight ? n : 1; i <= n; i++) {
      const p = part.getPointAtLength((part.length * i) / n);
      cur.pts.push({ x: p.x, y: p.y });
    }
    cur.at = part.end;
  }
  const closed = /z\s*$/i.test(String(d).trim());
  return lines.map((l) => ({ pts: l.pts, closed: closed && lines.length === 1 }));
}

function boundsOf(lines) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const l of lines) for (const p of l) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
}

/**
 * Turn shapes into ink strokes that fill the box (aspect kept, centered).
 * color(stroke|fill) maps an SVG color to an ink color, or null for none.
 */
function strokesFor({ shapes, viewBox }, box, { color, fallbackColor, size, lineWidth = null }) {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  let vb = viewBox;
  if (!vb) {
    const b = boundsOf(shapes.flatMap((s) => samplePath(s.d, 1).map((l) => l.pts)));
    const pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.02;
    vb = [b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2 || 1, b.y1 - b.y0 + pad * 2 || 1];
  }
  const scale = Math.min(w / vb[2], h / vb[3]);
  const ox = box.x0 + (w - vb[2] * scale) / 2 - vb[0] * scale;
  const oy = box.y0 + (h - vb[3] * scale) / 2 - vb[1] * scale;
  const out = [];
  let total = 0;
  for (const s of shapes) {
    const fill = s.fill === undefined || s.fill === '' ? null : color(s.fill);
    // As in SVG, a filled shape has no outline unless it asks for one; a bare shape is outlined.
    const stroke = s.stroke === undefined ? (fill ? null : fallbackColor) : color(s.stroke);
    if (!stroke && !fill) continue;
    const px = s.width != null ? Math.max(1, Math.min(40, s.width * scale)) : lineWidth;
    for (const line of samplePath(s.d, 2.5 / scale)) {
      if (out.length >= MAX_STROKES || total > MAX_POINTS) break;
      const points = line.pts.map((p) => ({ x: ox + p.x * scale, y: oy + p.y * scale }));
      total += points.length;
      const stroke0 = { tool: 'pen', sharp: true, color: stroke || fill, size, points };
      if (px) stroke0.px = px;
      if (fill && (line.closed || s.d.trim().match(/z\s*$/i))) stroke0.fill = fill;
      if (!stroke) stroke0.noStroke = true;
      out.push(stroke0);
    }
  }
  if (!out.length) throw new Error('Nothing visible to draw (every shape had stroke and fill set to none).');
  return out;
}

module.exports = { parseSvg, samplePath, strokesFor, toPathData };
