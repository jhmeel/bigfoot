'use strict';
// Tabler icons (MIT, packed by scripts/build-icons.js): 5,000+ line drawings on a 24×24 grid.

const fs = require('fs');
const path = require('path');

let data = null;
function load() {
  if (!data) {
    try {
      data = JSON.parse(fs.readFileSync(path.join(__dirname, 'icons.json'), 'utf8'));
    } catch {
      data = { icons: {}, tags: {} };
    }
  }
  return data;
}

const words = (s) => String(s || '').toLowerCase().replace(/^(a|an|the)\s+/, '').split(/[^a-z0-9]+/).filter(Boolean);

/** Icons that match the words, best first: exact name, all words in the name, then tags. */
function searchIcons(query, limit = 8) {
  const { icons, tags } = load();
  const q = words(query);
  if (!q.length) return [];
  const exact = q.join('-');
  const scored = [];
  for (const name of Object.keys(icons)) {
    const parts = name.split('-');
    let score = 0;
    if (name === exact) score = 100;
    else if (q.every((w) => parts.includes(w))) score = 60 - parts.length;
    else if (q.every((w) => parts.includes(w) || (tags[name] || '').split(' ').includes(w))) score = 30 - parts.length;
    else continue;
    if (/-(off|filled|question|exclamation|x|plus|minus|check|cog|search|share|star|up|down|dollar|code|bolt|cancel|pause|pin|heart)$/.test(name) && name !== exact) score -= 8;
    scored.push([score, name]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length).slice(0, limit).map(([, n]) => n);
}

function iconShapes(name) {
  const d = load().icons[name];
  return d ? { viewBox: [0, 0, 24, 24], shapes: d.map((x) => ({ d: x })) } : null;
}

const iconCount = () => Object.keys(load().icons).length;

module.exports = { searchIcons, iconShapes, iconCount };
