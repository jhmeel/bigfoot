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
  for (const m of src.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const a = { ...top, ...attrs(m[1]) };
    const text = m[2].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
    if (text) shapes.push({ text: text.slice(0, 200), x: num(a.x), y: num(a.y), fill: a.fill, stroke: 'none', fontSize: num(a['font-size'], 20) });
  }
  if (!shapes.length) throw new Error('The SVG has no shapes. Use path, line, polyline, polygon, circle, ellipse, rect, or text elements.');
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
    const b = boundsOf(shapes.flatMap((s) => (s.text ? [[{ x: s.x, y: s.y }]] : samplePath(s.d, 1).map((l) => l.pts))));
    const pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.02;
    vb = [b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2 || 1, b.y1 - b.y0 + pad * 2 || 1];
  }
  const scale = Math.min(w / vb[2], h / vb[3]);
  const ox = box.x0 + (w - vb[2] * scale) / 2 - vb[0] * scale;
  const oy = box.y0 + (h - vb[3] * scale) / 2 - vb[1] * scale;
  const out = [];
  let total = 0;
  for (const s of shapes) {
    if (s.text) {
      const size = Math.max(0, Math.min(3, Math.round((s.fontSize * scale - 14) / 6)));
      out.push({ tool: 'text', text: s.text, color: (s.fill && color(s.fill)) || fallbackColor, size, points: [{ x: ox + s.x * scale, y: oy + s.y * scale }] });
      continue;
    }
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

// the other way: ink → SVG
const INK_SIZES = [2, 4, 8, 14];
const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function inkWidth(s) {
  if (s.px) return s.px;
  const w = INK_SIZES[s.size] || INK_SIZES[1];
  return s.tool === 'highlighter' ? w * 3.2 + 6 : s.tool === 'brush' ? w * 2.4 + 4 : w;
}

/** Fewer points for long strokes, so the SVG stays readable (for people and for the model). */
function thinPoints(pts, max) {
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => pts[Math.round(i * step)]);
}

/**
 * The drawing as standalone SVG in its own coordinates (0,0 at the top-left of the drawing).
 * @param {object[]} strokes ink strokes in screen pixels
 * @returns {{ svg: string, box: {x0,y0,x1,y1} } | null}
 */
function strokesToSvg(strokes, { maxPoints = 60, pad = 12 } = {}) {
  const list = (strokes || []).filter((s) => s && Array.isArray(s.points) && s.points.length);
  if (!list.length) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const s of list) {
    const w = inkWidth(s) / 2 + (s.tool === 'text' ? 200 : 0);
    for (const p of s.points) { x0 = Math.min(x0, p.x - w); y0 = Math.min(y0, p.y - w); x1 = Math.max(x1, p.x + w); y1 = Math.max(y1, p.y + w); }
  }
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const r = (n) => Math.round(n * 10) / 10;
  const X = (p) => r(p.x - x0);
  const Y = (p) => r(p.y - y0);
  const body = [];
  for (const s of list) {
    const paint = `stroke="${s.noStroke ? 'none' : s.color}" stroke-width="${r(inkWidth(s))}" stroke-linecap="round" stroke-linejoin="round"`;
    const [a, b] = [s.points[0], s.points[s.points.length - 1]];
    if (s.tool === 'text') {
      body.push(`<text x="${X(a)}" y="${Y(a)}" fill="${s.color}" font-size="${14 + (s.size || 0) * 6}" font-weight="600" dominant-baseline="middle">${escapeXml(s.text || '')}</text>`);
    } else if (s.tool === 'line' || s.tool === 'arrow') {
      body.push(`<line x1="${X(a)}" y1="${Y(a)}" x2="${X(b)}" y2="${Y(b)}" ${paint}/>`);
      if (s.tool === 'arrow') {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const len = Math.max(12, inkWidth(s) * 3.6);
        const tip = (d) => `${r(X(b) - len * Math.cos(ang + d))},${r(Y(b) - len * Math.sin(ang + d))}`;
        body.push(`<polygon points="${X(b)},${Y(b)} ${tip(-0.45)} ${tip(0.45)}" fill="${s.color}"/>`);
      }
    } else if (s.tool === 'rect') {
      body.push(`<rect x="${r(Math.min(X(a), X(b)))}" y="${r(Math.min(Y(a), Y(b)))}" width="${r(Math.abs(b.x - a.x))}" height="${r(Math.abs(b.y - a.y))}" fill="none" ${paint}/>`);
    } else if (s.tool === 'ellipse') {
      body.push(`<ellipse cx="${r((X(a) + X(b)) / 2)}" cy="${r((Y(a) + Y(b)) / 2)}" rx="${r(Math.abs(b.x - a.x) / 2)}" ry="${r(Math.abs(b.y - a.y) / 2)}" fill="none" ${paint}/>`);
    } else {
      const pts = thinPoints(s.points, maxPoints);
      const d = `M${pts.map((p) => `${X(p)} ${Y(p)}`).join('L')}${s.fill ? 'Z' : ''}`;
      const extra = s.tool === 'highlighter' ? ' opacity="0.34"' : '';
      body.push(`<path d="${d}" fill="${s.fill || 'none'}" ${paint}${extra}/>`);
    }
  }
  const w = r(x1 - x0);
  const h = r(y1 - y0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n${body.join('\n')}\n</svg>`;
  return { svg, box: { x0, y0, x1, y1 } };
}

module.exports = { parseSvg, samplePath, strokesFor, toPathData, strokesToSvg };
