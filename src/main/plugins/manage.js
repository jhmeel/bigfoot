'use strict';
// Plugin management for Settings: what's installed, review before install, install, remove.

const fs = require('fs');
const path = require('path');
const { inspectPlugin } = require('./validate');
const { TEMPLATE, README } = require('./template');

const TEMPLATE_NAME = 'plugin-template.js';

const BUILTIN_GROUPS = {
  'builtin/annotate.js': 'Draw on the screen',
  'builtin/drawing.js': 'Edit your drawing',
  'builtin/apps.js': 'Open apps and websites',
  'builtin/files.js': 'Files and folders',
  'builtin/shell.js': 'Run commands',
  'builtin/screen.js': 'Read and use the screen',
  'builtin/web.js': 'Search and read the web',
};

class PluginManager {
  constructor({ registry, dir, logger, onChange = () => {} }) {
    Object.assign(this, { registry, dir, logger, onChange });
  }

  /** Where Add Plugin… opens: always holds the template (restored if it's deleted or edited). */
  templateDir() { return path.join(this.dir, 'template'); }

  ensureFolder() {
    fs.mkdirSync(this.templateDir(), { recursive: true });
    const readme = path.join(this.dir, 'README.txt');
    try { if (fs.readFileSync(readme, 'utf8') !== README) throw new Error('outdated'); } catch { fs.writeFileSync(readme, README); }
    // The template sits in a subfolder, so it's never loaded as a plugin itself, and it's read-only:
    // copy it next to it (or anywhere) to make your own.
    const file = path.join(this.templateDir(), TEMPLATE_NAME);
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
    if (current !== TEMPLATE) {
      try { fs.chmodSync(file, 0o666); } catch { /* missing */ }
      fs.writeFileSync(file, TEMPLATE);
    }
    try { fs.chmodSync(file, 0o444); } catch { /* not critical */ }
    return file;
  }

  list() {
    const bySource = new Map();
    for (const t of this.registry.list()) {
      if (!bySource.has(t.source)) bySource.set(t.source, []);
      bySource.get(t.source).push(t.name);
    }
    const builtin = [...bySource].filter(([src]) => src.startsWith('builtin/'))
      .map(([src, tools]) => ({ title: BUILTIN_GROUPS[src] || src.replace(/^builtin\/|\.js$/g, ''), tools: tools.sort() }))
      .sort((a, b) => a.title.localeCompare(b.title));
    const files = fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter((f) => f.endsWith('.js')).sort() : [];
    const custom = files.map((file) => ({
      file,
      tools: (bySource.get(file) || []).sort(),
      error: this.registry.failures.get(file) || (bySource.has(file) ? '' : 'Not loaded yet. Restart Bigfoot to load it.'),
    }));
    return { builtin, custom, dir: this.dir };
  }

  /** Check a file without installing it. */
  review(file) {
    return inspectPlugin(file, { existing: this.registry.names(path.basename(file)) });
  }

  /** Check again (never trust an earlier result), copy into the plugins folder, and load it. */
  async install(file) {
    const report = await this.review(file);
    if (!report.ok) return { ok: false, report };
    this.ensureFolder();
    const dest = path.join(this.dir, path.basename(file));
    if (path.resolve(dest) !== path.resolve(file)) {
      await fs.promises.chmod(dest, 0o666).catch(() => {});
      await fs.promises.copyFile(file, dest);
      await fs.promises.chmod(dest, 0o666).catch(() => {}); // a copy of the read-only template stays editable
    }
    const loaded = this.registry.loadUserPlugin(dest);
    if (!loaded) return { ok: false, report: { ...report, ok: false, errors: [this.registry.failures.get(path.basename(dest))] } };
    this.logger && this.logger.info(`Installed plugin ${path.basename(dest)}: ${report.tools.map((t) => t.name).join(', ')}`);
    this.onChange();
    return { ok: true, report };
  }

  async remove(file, trash) {
    const name = path.basename(file);
    const full = path.join(this.dir, name);
    this.registry.unregisterSource(name);
    if (fs.existsSync(full)) await trash(full);
    this.logger && this.logger.info(`Removed plugin ${name}`);
    this.onChange();
  }

}

module.exports = { PluginManager, BUILTIN_GROUPS, TEMPLATE_NAME };
