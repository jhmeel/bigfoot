'use strict';
// Packs the Tabler outline icons (MIT) into one small file the edit_drawing tool reads.

const fs = require('fs');
const path = require('path');

const pkg = path.join(__dirname, '..', 'node_modules', '@tabler', 'icons');
const out = path.join(__dirname, '..', 'src', 'main', 'plugins', 'lib', 'icons.json');

const nodes = require(path.join(pkg, 'tabler-nodes-outline.json'));
const meta = require(path.join(pkg, 'icons.json'));
const icons = {};
const tags = {};
for (const [name, elements] of Object.entries(nodes)) {
  const paths = elements.filter(([tag, a]) => tag === 'path' && a.d && a.stroke !== 'none').map(([, a]) => a.d);
  if (!paths.length) continue;
  icons[name] = paths;
  const m = meta[name];
  if (m) tags[name] = [m.category, ...(m.tags || [])].filter((t) => t != null && t !== '').join(' ').toLowerCase();
}
const license = fs.readFileSync(path.join(pkg, 'LICENSE'), 'utf8');
const { version } = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
fs.writeFileSync(out, JSON.stringify({ source: `@tabler/icons ${version}`, license, icons, tags }));
console.log(`Packed ${Object.keys(icons).length} icons into ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
