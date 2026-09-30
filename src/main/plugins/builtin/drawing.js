'use strict';

const SHAPES = ['path', 'line', 'arrow', 'rect', 'ellipse', 'text'];
const PENS = ['pen', 'brush', 'highlighter'];
const COLORS = { white: '#ffffff', black: '#1c1c1e', red: '#ff453a', orange: '#ff9f0a', yellow: '#ffd60a', green: '#32d74b', blue: '#0a84ff', purple: '#bf5af2' };
const WIDTHS = { fine: 0, medium: 1, thick: 2, extra: 3 };

module.exports = {
  name: 'edit_drawing',
  description: 'Change the drawing the user made on their screen with the Draw tool (it appears in your screenshots). Use it to correct, neaten, complete, or improve their drawing: erase part of it and redraw it cleanly, or add strokes, shapes, arrows, and text. Your changes become part of their drawing, and they can undo them. Coordinates are pixels in the latest screenshot. Take a screenshot afterwards to check the result.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'erase', 'clear'], description: 'add: draw something. erase: remove the user\'s strokes that touch region. clear: remove the whole drawing.' },
      shape: { type: 'string', enum: SHAPES, description: 'For add. path: freehand through points (2-400). line/arrow: points = [from, to]. rect/ellipse: points = [top-left, bottom-right]. text: points = [position], with text.' },
      points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'List of [x, y] screenshot pixel coordinates.' },
      region: { type: 'array', items: { type: 'number' }, description: 'For erase: [x0, y0, x1, y1].' },
      text: { type: 'string', description: 'For shape "text".' },
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
