'use strict';

const os = require('os');
const path = require('path');

const KNOWN_FOLDERS = {
  desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures',
  music: 'Music', videos: 'Videos', home: '',
};

/** Accepts absolute paths, ~, %ENV% variables, and "Desktop/…"-style shortcuts. */
function resolvePath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('A path is required.');
  let s = p.trim().replace(/^["']|["']$/g, '');
  s = s.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  const first = s.split(/[\\/]/)[0].toLowerCase();
  if (!path.isAbsolute(s) && first in KNOWN_FOLDERS) s = path.join(os.homedir(), KNOWN_FOLDERS[first], s.slice(first.length));
  if (!path.isAbsolute(s)) s = path.join(os.homedir(), s);
  return path.normalize(s);
}

/** Refuse writes to system folders, drive roots, and the home folder itself, even with approval. */
function assertWritable(p) {
  const lower = path.normalize(p).toLowerCase().replace(/\\+$/, '');
  const sysRoot = (process.env.SystemRoot || 'C:\\Windows').toLowerCase();
  const protectedRoots = [sysRoot, 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata\\microsoft'];
  if (protectedRoots.some((r) => lower === r || lower.startsWith(r + '\\'))) {
    throw new Error(`For safety I can't change system folders (${p}).`);
  }
  if (/^[a-z]:$/i.test(lower)) throw new Error('For safety I can\'t change the root of a drive.');
  if (path.normalize(os.homedir()).toLowerCase() === lower) throw new Error('For safety I can\'t delete or replace your whole home folder.');
}

module.exports = { resolvePath, assertWritable };
