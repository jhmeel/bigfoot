'use strict';
// Simple line drawings for edit_drawing's "picture" shape. Each is a list of strokes in a unit square
// (0..1, y down); the tool scales them into the box the model asks for.

const TAU = Math.PI * 2;

function arc(cx, cy, rx, ry, from = 0, to = TAU, n = 32) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = from + ((to - from) * i) / n;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}
const circle = (cx, cy, r, n) => arc(cx, cy, r, r, 0, TAU, n);
const closed = (pts) => [...pts, pts[0]];

function star(cx, cy, outer, inner, spikes = 5) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 ? inner : outer;
    const t = -Math.PI / 2 + (i * Math.PI) / spikes;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return closed(pts);
}

function heart(cx, cy, s) {
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * TAU;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([cx + (x / 34) * s, cy - (y / 34) * s]);
  }
  return pts;
}

/** Closed outline around a center whose radius varies with the angle. */
function polar(cx, cy, radius, sx = 1, n = 64) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * TAU;
    const r = radius(t);
    pts.push([cx + sx * r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}

/** Arc of a circle from one angle to another, the way that passes the angle "through". */
function arcVia(cx, cy, r, from, to, through, n = 28) {
  const norm = (a) => ((a % TAU) + TAU) % TAU;
  const span = norm(to - from);
  const end = norm(through - from) < span ? from + span : from - (TAU - span);
  return arc(cx, cy, r, r, from, end, n);
}

/** The outline of circle 1 with circle 2 bitten out of it. */
function crescent(x1, y1, r1, x2, y2, r2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(r1 * r1 - a * a);
  const px = x1 + (a * dx) / d;
  const py = y1 + (a * dy) / d;
  const i1 = [px - (h * dy) / d, py + (h * dx) / d];
  const i2 = [px + (h * dy) / d, py - (h * dx) / d];
  const toward = Math.atan2(dy, dx);
  const at = (c, p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const outer = arcVia(x1, y1, r1, at([x1, y1], i1), at([x1, y1], i2), toward + Math.PI);
  const inner = arcVia(x2, y2, r2, at([x2, y2], i2), at([x2, y2], i1), toward + Math.PI);
  return [...outer, ...inner];
}

function rays(cx, cy, r0, r1, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * TAU;
    out.push([[cx + r0 * Math.cos(t), cy + r0 * Math.sin(t)], [cx + r1 * Math.cos(t), cy + r1 * Math.sin(t)]]);
  }
  return out;
}

const PICTURES = {
  bird: () => [
    arc(0.45, 0.56, 0.27, 0.17, -0.35, TAU - 1.05, 40), // body, open where the head joins
    circle(0.72, 0.38, 0.11),
    [[0.82, 0.34], [0.96, 0.39], [0.82, 0.43]], // beak
    circle(0.745, 0.355, 0.016, 10),
    [[0.27, 0.55], [0.36, 0.47], [0.48, 0.47], [0.6, 0.55], [0.46, 0.62], [0.34, 0.6], [0.27, 0.55]], // wing
    [[0.2, 0.5], [0.04, 0.4], [0.08, 0.56], [0.04, 0.7], [0.2, 0.62]], // tail
    [[0.42, 0.72], [0.4, 0.9], [0.35, 0.93]], [[0.4, 0.9], [0.45, 0.93]],
    [[0.54, 0.72], [0.56, 0.9], [0.51, 0.93]], [[0.56, 0.9], [0.61, 0.93]],
  ],
  heart: () => [heart(0.5, 0.5, 0.95)],
  star: () => [star(0.5, 0.53, 0.46, 0.19)],
  smiley: () => [
    circle(0.5, 0.5, 0.44, 48),
    circle(0.36, 0.38, 0.045, 12), circle(0.64, 0.38, 0.045, 12),
    arc(0.5, 0.52, 0.24, 0.2, 0.35, Math.PI - 0.35, 20),
  ],
  sun: () => [circle(0.5, 0.5, 0.22, 40), ...rays(0.5, 0.5, 0.29, 0.46, 12)],
  house: () => [
    closed([[0.18, 0.45], [0.82, 0.45], [0.82, 0.92], [0.18, 0.92]]),
    [[0.1, 0.48], [0.5, 0.1], [0.9, 0.48]],
    [[0.43, 0.92], [0.43, 0.68], [0.57, 0.68], [0.57, 0.92]],
    closed([[0.25, 0.55], [0.37, 0.55], [0.37, 0.67], [0.25, 0.67]]),
    closed([[0.63, 0.55], [0.75, 0.55], [0.75, 0.67], [0.63, 0.67]]),
    [[0.66, 0.252], [0.66, 0.14], [0.74, 0.14], [0.74, 0.328]], // chimney
  ],
  tree: () => [
    [[0.44, 0.95], [0.455, 0.67]], [[0.56, 0.95], [0.545, 0.67]], [[0.36, 0.95], [0.64, 0.95]],
    polar(0.5, 0.38, (t) => 0.29 + 0.025 * Math.cos(7 * t)),
  ],
  flower: () => {
    const petals = [];
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * TAU;
      const cx = 0.5 + 0.15 * Math.cos(t);
      const cy = 0.32 + 0.15 * Math.sin(t);
      petals.push(arc(cx, cy, 0.09, 0.09, 0, TAU, 20));
    }
    return [...petals, circle(0.5, 0.32, 0.07, 16), [[0.5, 0.48], [0.49, 0.7], [0.5, 0.95]],
      [[0.495, 0.75], [0.62, 0.64], [0.72, 0.66], [0.6, 0.76], [0.495, 0.75]]];
  },
  cat: () => [
    circle(0.5, 0.4, 0.22, 40),
    [[0.33, 0.27], [0.3, 0.08], [0.45, 0.19]], [[0.55, 0.19], [0.7, 0.08], [0.67, 0.27]],
    circle(0.42, 0.37, 0.028, 10), circle(0.58, 0.37, 0.028, 10),
    [[0.48, 0.45], [0.52, 0.45], [0.5, 0.48], [0.48, 0.45]],
    [[0.5, 0.48], [0.46, 0.52]], [[0.5, 0.48], [0.54, 0.52]],
    [[0.44, 0.47], [0.2, 0.43]], [[0.44, 0.49], [0.2, 0.52]], [[0.56, 0.47], [0.8, 0.43]], [[0.56, 0.49], [0.8, 0.52]],
    arc(0.5, 0.8, 0.2, 0.18, -1.05, 4.19, 30),
    [[0.69, 0.87], [0.85, 0.85], [0.9, 0.7], [0.84, 0.6]],
  ],
  fish: () => [
    arc(0.45, 0.5, 0.3, 0.2, 0.35, TAU - 0.35, 40),
    [[0.73, 0.43], [0.95, 0.28], [0.9, 0.5], [0.95, 0.72], [0.73, 0.57]],
    circle(0.28, 0.45, 0.03, 10),
    arc(0.36, 0.5, 0.08, 0.14, -1.2, 1.2, 12),
  ],
  cloud: () => [[
    [0.2, 0.7], ...arc(0.22, 0.58, 0.12, 0.12, 1.6, 4.6, 12), ...arc(0.4, 0.42, 0.18, 0.18, 3.3, 5.6, 14),
    ...arc(0.64, 0.44, 0.16, 0.16, 3.6, 6.0, 14), ...arc(0.8, 0.6, 0.11, 0.11, 4.4, 7.8, 12), [0.2, 0.7],
  ]],
  moon: () => [crescent(0.46, 0.52, 0.4, 0.66, 0.4, 0.34)],
  car: () => [
    [[0.06, 0.66], [0.06, 0.5], [0.24, 0.47], [0.34, 0.32], [0.66, 0.32], [0.78, 0.47], [0.94, 0.5], [0.94, 0.66], [0.8, 0.66]],
    [[0.34, 0.66], [0.66, 0.66]], [[0.06, 0.66], [0.2, 0.66]],
    circle(0.27, 0.67, 0.07, 20), circle(0.73, 0.67, 0.07, 20),
    [[0.28, 0.47], [0.36, 0.36], [0.49, 0.36], [0.49, 0.47], [0.28, 0.47]],
    [[0.53, 0.47], [0.53, 0.36], [0.64, 0.36], [0.73, 0.47], [0.53, 0.47]],
  ],
  boat: () => [
    [[0.08, 0.66], [0.92, 0.66], [0.78, 0.84], [0.22, 0.84], [0.08, 0.66]],
    [[0.5, 0.66], [0.5, 0.1]], [[0.5, 0.12], [0.84, 0.58], [0.5, 0.58]], [[0.47, 0.2], [0.2, 0.58], [0.47, 0.58]],
    [[0.05, 0.92], [0.2, 0.89], [0.35, 0.92], [0.5, 0.89], [0.65, 0.92], [0.8, 0.89], [0.95, 0.92]],
  ],
  mountain: () => [
    [[0.02, 0.88], [0.34, 0.3], [0.5, 0.56], [0.66, 0.2], [0.98, 0.88], [0.02, 0.88]],
    [[0.24, 0.48], [0.3, 0.44], [0.34, 0.5], [0.39, 0.44], [0.43, 0.48]],
    [[0.56, 0.38], [0.62, 0.34], [0.66, 0.4], [0.71, 0.34], [0.76, 0.4]],
  ],
  apple: () => [
    polar(0.5, 0.58, (t) => {
      const top = Math.atan2(Math.sin(t + Math.PI / 2), Math.cos(t + Math.PI / 2));
      const bottom = Math.atan2(Math.sin(t - Math.PI / 2), Math.cos(t - Math.PI / 2));
      return 0.34 * (1 - 0.2 * Math.exp(-(top * top) / 0.06) - 0.05 * Math.exp(-(bottom * bottom) / 0.04));
    }, 1.05),
    [[0.5, 0.31], [0.52, 0.12]], [[0.53, 0.18], [0.66, 0.08], [0.76, 0.14], [0.62, 0.22], [0.53, 0.18]],
  ],
  balloon: () => [
    arc(0.5, 0.36, 0.26, 0.31, 0, TAU, 40),
    [[0.47, 0.69], [0.53, 0.69], [0.5, 0.66], [0.47, 0.69]],
    [[0.5, 0.69], [0.46, 0.77], [0.54, 0.85], [0.47, 0.96]],
  ],
  butterfly: () => [
    [[0.5, 0.3], [0.5, 0.78]],
    [[0.5, 0.45], [0.3, 0.14], [0.08, 0.2], [0.14, 0.44], [0.5, 0.5]],
    [[0.5, 0.45], [0.7, 0.14], [0.92, 0.2], [0.86, 0.44], [0.5, 0.5]],
    [[0.5, 0.52], [0.2, 0.6], [0.2, 0.82], [0.4, 0.78], [0.5, 0.58]],
    [[0.5, 0.52], [0.8, 0.6], [0.8, 0.82], [0.6, 0.78], [0.5, 0.58]],
    [[0.5, 0.3], [0.42, 0.16]], [[0.5, 0.3], [0.58, 0.16]],
  ],
  person: () => [
    circle(0.5, 0.18, 0.1, 24),
    [[0.5, 0.28], [0.5, 0.62]], [[0.26, 0.4], [0.5, 0.36], [0.74, 0.4]],
    [[0.34, 0.92], [0.5, 0.62], [0.66, 0.92]],
  ],
  arrow_right: () => [[[0.08, 0.5], [0.9, 0.5]], [[0.66, 0.28], [0.92, 0.5], [0.66, 0.72]]],
  check: () => [[[0.12, 0.52], [0.4, 0.8], [0.9, 0.2]]],
  cross: () => [[[0.15, 0.15], [0.85, 0.85]], [[0.85, 0.15], [0.15, 0.85]]],
  question: () => [
    [...arc(0.5, 0.3, 0.2, 0.18, Math.PI, TAU + 0.8, 18), [0.5, 0.6], [0.5, 0.68]],
    circle(0.5, 0.84, 0.03, 10),
  ],
};

const ALIASES = {
  birds: 'bird', dove: 'bird', sparrow: 'bird', robin: 'bird', love: 'heart', smile: 'smiley', face: 'smiley',
  'smiley face': 'smiley', emoji: 'smiley', home: 'house', kitten: 'cat', kitty: 'cat', flowers: 'flower', rose: 'flower',
  stars: 'star', sunshine: 'sun', clouds: 'cloud', crescent: 'moon', automobile: 'car', ship: 'boat', sailboat: 'boat',
  mountains: 'mountain', hill: 'mountain', fruit: 'apple', stickman: 'person', 'stick figure': 'person', man: 'person',
  woman: 'person', human: 'person', arrow: 'arrow_right', tick: 'check', checkmark: 'check', x: 'cross',
};

/** @returns {string|null} the library name for what the model asked for */
function pictureName(subject) {
  const s = String(subject || '').toLowerCase().trim().replace(/^(a|an|the)\s+/, '').replace(/[\s-]+/g, ' ');
  if (PICTURES[s]) return s;
  if (ALIASES[s]) return ALIASES[s];
  const word = s.split(' ').reverse().find((w) => PICTURES[w] || ALIASES[w]);
  return word ? (PICTURES[word] ? word : ALIASES[word]) : null;
}

/** Strokes for a picture, fitted (square, centered) into the box {x0, y0, x1, y1}. */
function pictureStrokes(name, box) {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const size = Math.min(w, h);
  const ox = box.x0 + (w - size) / 2;
  const oy = box.y0 + (h - size) / 2;
  return PICTURES[name]().map((stroke) => stroke.map(([x, y]) => ({ x: ox + x * size, y: oy + y * size })));
}

module.exports = { PICTURES, pictureName, pictureStrokes };
