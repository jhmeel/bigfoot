'use strict';

const SHAPES = ['box', 'spotlight', 'circle', 'arrow', 'line', 'path', 'text', 'clear'];
const COLORS = ['blue', 'red', 'green', 'yellow', 'white'];
const MIN_POINTS = { box: 2, spotlight: 2, circle: 2, arrow: 2, line: 2, path: 2, text: 1 };

module.exports = {
  name: 'annotate',
  description: 'Draw on the user\'s screen to show or explain something: highlight a component with a box or spotlight, circle it, point at it with an arrow, draw lines or a freehand path, or place a text label. Coordinates are pixels in the latest screenshot. Drawings are visible to the user only (they do not appear in your screenshots) and fade after duration_seconds. Use shape "clear" to remove all drawings.',
  input_schema: {
    type: 'object',
    properties: {
      shape: { type: 'string', enum: SHAPES, description: 'box/spotlight/circle: points = [top-left, bottom-right]. arrow/line: points = [from, to]. path: 2-200 points. text: points = [position].' },
      points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, description: 'List of [x, y] screenshot pixel coordinates.' },
      label: { type: 'string', description: 'Optional short caption shown next to the drawing (required for shape "text").' },
      color: { type: 'string', enum: COLORS, description: 'Defaults to blue. Use red for warnings or mistakes.' },
      duration_seconds: { type: 'number', description: 'How long the drawing stays, 1-120. Default 8.' },
    },
    required: ['shape'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    const { shape } = input;
    if (!SHAPES.includes(shape)) throw new Error(`shape must be one of ${SHAPES.join(', ')}`);
    if (shape === 'clear') {
      ctx.draw({ shape: 'clear' });
      return 'Cleared all drawings.';
    }
    const points = Array.isArray(input.points) ? input.points.slice(0, 200) : [];
    if (points.length < MIN_POINTS[shape]) throw new Error(`shape "${shape}" needs at least ${MIN_POINTS[shape]} point(s)`);
    if (shape === 'text' && !input.label) throw new Error('shape "text" needs a label');
    const local = points.map((p) => {
      if (!Array.isArray(p) || p.length !== 2) throw new Error('Each point must be [x, y]');
      return ctx.screen.sentToLocalDip(p.map(Number));
    });
    ctx.draw({
      shape,
      points: local,
      label: input.label ? String(input.label).slice(0, 120) : '',
      color: COLORS.includes(input.color) ? input.color : 'blue',
      duration: Math.max(1, Math.min(Number(input.duration_seconds) || 8, 120)),
    });
    return 'Drawn on the user\'s screen. Drawings don\'t appear in your screenshots.';
  },
};
