'use strict';

const { PICTURES, pictureName, pictureStrokes } = require('../lib/pictures');
const { searchIcons, iconShapes, iconCount } = require('../lib/icons');
const { parseSvg, strokesFor } = require('../lib/vector');

const SHAPES = ['picture', 'svg', 'path', 'line', 'arrow', 'rect', 'ellipse', 'text'];
const PENS = ['pen', 'brush', 'highlighter'];
const COLORS = { white: '#ffffff', black: '#1c1c1e', red: '#ff453a', orange: '#ff9f0a', yellow: '#ffd60a', green: '#32d74b', blue: '#0a84ff', purple: '#bf5af2' };
const CSS_COLORS = {
  ...COLORS, gray: '#8e8e93', grey: '#8e8e93', brown: '#a2845e', pink: '#ff375f', cyan: '#64d2ff', teal: '#30b0c7',
  navy: '#1d3a8a', gold: '#ffc53d', silver: '#c7c7cc', lime: '#a3e635', maroon: '#8b1e2d', olive: '#808000',
  skyblue: '#87ceeb', darkgreen: '#1f7a3a', lightblue: '#9fd3ff', beige: '#f5deb3', tan: '#d2b48c',
};
const WIDTHS = { fine: 0, medium: 1, thick: 2, extra: 3 };

/** An SVG/CSS color as ink: named, #rgb, #rrggbb, or null for "none". */
function inkColor(value, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v === 'currentcolor' || v === 'inherit') return fallback;
  if (v === 'none' || v === 'transparent') return null;
  if (CSS_COLORS[v]) return CSS_COLORS[v];
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`;
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v);
  if (rgb) return `#${rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
  return fallback;
}

/** Where to put a picture or SVG: the two points given, one point as its center, or mid-screen. */
function boxFor(input, ctx, toLocal) {
  const pts = Array.isArray(input.points) ? input.points : [];
  if (pts.length >= 2) {
    const a = toLocal(pts[0]);
    const b = toLocal(pts[pts.length - 1]);
    const box = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    if (box.x1 - box.x0 >= 24 && box.y1 - box.y0 >= 24) return box;
  }
  const { width, height } = ctx.screen.display.bounds;
  const c = pts.length === 1 ? toLocal(pts[0]) : { x: width / 2, y: height / 2 };
  const half = Math.min(width, height) * 0.16;
  return { x0: c.x - half, y0: c.y - half, x1: c.x + half, y1: c.y + half };
}

async function addPicture(input, ctx, toLocal) {
  const subject = String(input.subject || input.text || '').trim();
  const box = boxFor(input, ctx, toLocal);
  const color = inkColor(input.color, COLORS.blue) || COLORS.blue;
  const size = WIDTHS[input.width] ?? 1;
  const drawn = pictureName(subject);
  let strokes;
  let what;
  if (drawn) {
    strokes = pictureStrokes(drawn, box).map((points) => ({ tool: 'pen', color, size, points }));
    what = drawn.replace('_', ' ');
  } else {
    const [icon] = searchIcons(subject, 1);
    if (!icon) {
      const near = searchIcons(subject.split(/\s+/).pop(), 6);
      throw new Error(`No picture of "${subject}".${near.length ? ` Close matches: ${near.join(', ')}.` : ''} Otherwise draw it yourself with shape "svg".`);
    }
    strokes = strokesFor(iconShapes(icon), box, { color: (c) => inkColor(c, color), fallbackColor: color, size });
    what = icon.replace(/-/g, ' ');
  }
  await ctx.ink({ op: 'add', strokes });
  return `Drew ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what}.`;
}

async function addSvg(input, ctx, toLocal) {
  const svg = parseSvg(input.svg);
  const color = inkColor(input.color, COLORS.blue) || COLORS.blue;
  const strokes = strokesFor(svg, boxFor(input, ctx, toLocal), {
    color: (c) => inkColor(c, color), fallbackColor: color, size: WIDTHS[input.width] ?? 1,
  });
  await ctx.ink({ op: 'add', strokes });
  return `Drew ${svg.shapes.length} shape${svg.shapes.length === 1 ? '' : 's'} (${strokes.length} strokes).`;
}

module.exports = {
  name: 'edit_drawing',
  description: `Draw on the user's screen, or change the drawing they made with the Draw tool (it appears in your screenshots). Your changes become part of their drawing, and they can undo them. Coordinates are pixels in the latest screenshot.
To draw a thing, use shape "picture" with its subject: a ready line drawing from a library of ${Object.keys(PICTURES).length} pictures and ${iconCount() || 'thousands of'} icons (animals, food, transport, buildings, tools, weather, sports, devices, symbols…). For anything else, or a detailed or colored illustration, use shape "svg" with SVG markup you write yourself. To neaten the user's rough shapes, use action "tidy". Never trace a picture point by point with "path".`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'erase', 'clear', 'tidy'], description: 'add: draw something. erase: remove strokes that touch region. clear: remove the whole drawing. tidy: turn the user\'s rough lines, circles, ellipses, rectangles, and triangles into perfect ones (in region, or everywhere).' },
      shape: { type: 'string', enum: SHAPES, description: 'For add. picture: a ready drawing of subject. svg: your own SVG markup in svg. For both, points = [top-left, bottom-right] of where it goes (or one point as its center; default: the middle of the screen). path: freehand through points (2-400). line/arrow: points = [from, to]. rect/ellipse: points = [top-left, bottom-right]. text: points = [position], with text.' },
      points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'List of [x, y] screenshot pixel coordinates.' },
      region: { type: 'array', items: { type: 'number' }, description: 'For erase and tidy: [x0, y0, x1, y1].' },
      subject: { type: 'string', description: 'For shape "picture": what to draw, e.g. "bird", "rocket", "coffee cup", "bicycle".' },
      svg: { type: 'string', description: 'For shape "svg": markup like <svg viewBox="0 0 100 100">…</svg> using path, line, polyline, polygon, circle, ellipse, and rect, with stroke, fill, and stroke-width attributes (colors as names or #hex; fill="none" for outlines). Groups (g) pass their attributes down; transforms are not supported. It is scaled to fit the box.' },
      text: { type: 'string', description: 'For shape "text".' },
      color: { type: 'string', description: `Main color: ${Object.keys(COLORS).join(', ')}, or #rrggbb. Defaults to red for strokes and shapes, blue for pictures.` },
      width: { type: 'string', enum: Object.keys(WIDTHS), description: 'Stroke width. Defaults to medium.' },
      pen: { type: 'string', enum: PENS, description: 'For path: pen (default), brush (soft and bold), or highlighter (translucent).' },
    },
    required: ['action'],
  },

  async run(input, ctx) {
    const toLocal = (p) => {
      if (!Array.isArray(p) || p.length !== 2) throw new Error('Each point must be [x, y]');
      return ctx.screen.sentToLocalDip(p.map(Number));
    };
    const rectFrom = (r) => {
      if (!Array.isArray(r) || r.length !== 4) return null;
      const a = toLocal([Math.min(r[0], r[2]), Math.min(r[1], r[3])]);
      const b = toLocal([Math.max(r[0], r[2]), Math.max(r[1], r[3])]);
      return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    };
    if (input.action === 'clear') {
      ctx.ink({ op: 'clear' });
      return 'Cleared the drawing.';
    }
    if (input.action === 'erase') {
      const rect = rectFrom(input.region);
      if (!rect) throw new Error('erase needs region [x0, y0, x1, y1]');
      const removed = await ctx.ink({ op: 'erase', rect });
      return removed ? `Erased ${removed} stroke${removed === 1 ? '' : 's'}.` : 'Nothing was drawn in that region.';
    }
    if (input.action === 'tidy') {
      const n = await ctx.ink({ op: 'tidy', rect: rectFrom(input.region) });
      return n ? `Tidied ${n} shape${n === 1 ? '' : 's'}.` : 'Found no rough lines, circles, or boxes to tidy.';
    }
    if (input.action !== 'add') throw new Error('action must be add, erase, clear, or tidy');
    if (input.shape === 'svg' || (input.svg && !input.shape)) return addSvg(input, ctx, toLocal);
    if (input.shape === 'picture' || (input.subject && !input.shape)) return addPicture(input, ctx, toLocal);
    const shape = SHAPES.includes(input.shape) ? input.shape : 'path';
    const points = (Array.isArray(input.points) ? input.points.slice(0, 400) : []).map(toLocal);
    const need = shape === 'text' ? 1 : 2;
    if (points.length < need) throw new Error(`shape "${shape}" needs at least ${need} point(s)`);
    if (shape === 'text' && !String(input.text || '').trim()) throw new Error('shape "text" needs text');
    const tool = shape === 'path' ? (PENS.includes(input.pen) ? input.pen : 'pen') : shape;
    await ctx.ink({
      op: 'add',
      stroke: {
        tool,
        color: inkColor(input.color, COLORS.red) || COLORS.red,
        size: WIDTHS[input.width] ?? 1,
        points: shape === 'path' || shape === 'text' ? points : [points[0], points[points.length - 1]],
        text: shape === 'text' ? String(input.text).slice(0, 200) : undefined,
      },
    });
    return `Added ${/^[aeiou]/.test(shape) ? 'an' : 'a'} ${shape} to the drawing.`;
  },
};
