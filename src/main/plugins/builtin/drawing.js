'use strict';

const { PICTURES, pictureName, pictureStrokes } = require('../lib/pictures');

const SHAPES = ['picture', 'path', 'line', 'arrow', 'rect', 'ellipse', 'text'];
const PENS = ['pen', 'brush', 'highlighter'];
const COLORS = { white: '#ffffff', black: '#1c1c1e', red: '#ff453a', orange: '#ff9f0a', yellow: '#ffd60a', green: '#32d74b', blue: '#0a84ff', purple: '#bf5af2' };
const WIDTHS = { fine: 0, medium: 1, thick: 2, extra: 3 };

async function addPicture(input, ctx, toLocal) {
  const name = pictureName(input.subject || input.text);
  if (!name) {
    throw new Error(`No ready picture of "${input.subject || ''}". Available: ${Object.keys(PICTURES).join(', ')}. Otherwise draw it from simple shapes (ellipse, path, line).`);
  }
  let box;
  const pts = Array.isArray(input.points) ? input.points : [];
  if (pts.length >= 2) {
    const a = toLocal(pts[0]);
    const b = toLocal(pts[pts.length - 1]);
    box = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  }
  if (!box || box.x1 - box.x0 < 24 || box.y1 - box.y0 < 24) {
    const { width, height } = ctx.screen.display.bounds;
    const c = pts.length === 1 ? toLocal(pts[0]) : { x: width / 2, y: height / 2 };
    const half = Math.min(width, height) * 0.16;
    box = { x0: c.x - half, y0: c.y - half, x1: c.x + half, y1: c.y + half };
  }
  const color = COLORS[input.color] || COLORS.blue;
  const size = WIDTHS[input.width] ?? 1;
  for (const points of pictureStrokes(name, box)) {
    await ctx.ink({ op: 'add', stroke: { tool: 'pen', color, size, points } });
  }
  return `Drew ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name.replace('_', ' ')}.`;
}

module.exports = {
  name: 'edit_drawing',
  description: 'Change the drawing the user made on their screen with the Draw tool (it appears in your screenshots). Use it to correct, neaten, complete, or improve their drawing: erase part of it and redraw it cleanly, or add strokes, shapes, arrows, and text. Your changes become part of their drawing, and they can undo them. To draw a thing (a bird, heart, house…) use shape "picture" with its subject: it is drawn cleanly for you, never trace it point by point. Coordinates are pixels in the latest screenshot.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'erase', 'clear'], description: 'add: draw something. erase: remove the user\'s strokes that touch region. clear: remove the whole drawing.' },
      shape: { type: 'string', enum: SHAPES, description: 'For add. picture: a ready drawing of subject, points = [top-left, bottom-right] of where it goes (optional: defaults to the middle of the screen). path: freehand through points (2-400). line/arrow: points = [from, to]. rect/ellipse: points = [top-left, bottom-right]. text: points = [position], with text.' },
      points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'List of [x, y] screenshot pixel coordinates.' },
      region: { type: 'array', items: { type: 'number' }, description: 'For erase: [x0, y0, x1, y1].' },
      text: { type: 'string', description: 'For shape "text".' },
      subject: { type: 'string', description: `For shape "picture": one of ${Object.keys(PICTURES).join(', ')}.` },
      color: { type: 'string', enum: Object.keys(COLORS), description: 'Defaults to red.' },
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
    if (input.action === 'clear') {
      ctx.ink({ op: 'clear' });
      return 'Cleared the drawing.';
    }
    if (input.action === 'erase') {
      const r = input.region;
      if (!Array.isArray(r) || r.length !== 4) throw new Error('erase needs region [x0, y0, x1, y1]');
      const a = toLocal([Math.min(r[0], r[2]), Math.min(r[1], r[3])]);
      const b = toLocal([Math.max(r[0], r[2]), Math.max(r[1], r[3])]);
      const removed = await ctx.ink({ op: 'erase', rect: { x0: a.x, y0: a.y, x1: b.x, y1: b.y } });
      return removed ? `Erased ${removed} stroke${removed === 1 ? '' : 's'}.` : 'Nothing was drawn in that region.';
    }
    if (input.action !== 'add') throw new Error('action must be add, erase, or clear');
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
        color: COLORS[input.color] || COLORS.red,
        size: WIDTHS[input.width] ?? 1,
        points: shape === 'path' || shape === 'text' ? points : [points[0], points[points.length - 1]],
        text: shape === 'text' ? String(input.text).slice(0, 200) : undefined,
      },
    });
    return `Added ${/^[aeiou]/.test(shape) ? 'an' : 'a'} ${shape} to the drawing.`;
  },
};
