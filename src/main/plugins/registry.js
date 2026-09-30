'use strict';
// Tool plugins. A plugin module exports one tool definition or an array of them:
//
//   module.exports = {
//     name: 'word_count',                         // ^[a-z][a-z0-9_]{1,63}$, unique
//     description: 'What it does and when to use it. Claude reads this.',
//     input_schema: { type: 'object', properties: { ... }, required: [...] },
//     async run(input, ctx) { return 'text result' },   // or an array of content blocks
//   };
//
// ctx gives plugins what they need without reaching into the app:
//   ctx.confirm(level, { title, message, detail, confirm, destructive })
//       level 'read' asks only in "Every action" mode, 'change' unless approvals are off,
//       'always' in every mode. Throws if the user declines.
//   ctx.signal        AbortSignal, fires when the user presses Esc
//   ctx.log(kind, text)   write to the Bigfoot Terminal ('info', 'stdout', 'stderr', ...)
//   ctx.screen        the ScreenTarget being controlled (coordinate mapping, screenshots)
//   ctx.draw(shape)   send a drawing to the overlay
//   ctx.sleep(ms)     abortable delay
//
// Changing the tool list mid-conversation would invalidate the prompt cache, so adding or removing
// a plugin starts a new conversation.

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const RESERVED = new Set(['computer', 'screenshot', 'zoom', 'key', 'type', 'wait', 'scroll']);

class PluginRegistry {
  constructor(logger) {
    this.logger = logger;
    this.tools = new Map();
    this.sources = new Map();
    this.failures = new Map(); // user plugin file -> why it didn't load
    this.version = 0;          // bumps whenever the tool list changes
  }

  register(def, source = 'builtin') {
    const problem = validate(def);
    if (problem) throw new Error(`Plugin ${def && def.name ? def.name : '(unnamed)'} from ${source}: ${problem}`);
    if (this.tools.has(def.name)) throw new Error(`Plugin ${def.name} from ${source} clashes with one from ${this.sources.get(def.name)}`);
    this.tools.set(def.name, def);
    this.sources.set(def.name, source);
    this.version++;
  }

  /** All of a module's tools or none of them. */
  registerModule(mod, source) {
    const defs = Array.isArray(mod) ? mod : [mod];
    const names = new Set();
    for (const def of defs) {
      const problem = validate(def);
      if (problem) throw new Error(`${def && def.name ? def.name : '(unnamed)'}: ${problem}`);
      if (this.tools.has(def.name) || names.has(def.name)) throw new Error(`${def.name} clashes with another tool`);
      names.add(def.name);
    }
    for (const def of defs) this.register(def, source);
  }

  unregisterSource(source) {
    for (const [name, src] of [...this.sources]) {
      if (src === source) { this.tools.delete(name); this.sources.delete(name); this.version++; }
    }
    this.failures.delete(source);
  }

  /** Load (or reload) one user plugin file. */
  loadUserPlugin(full) {
    const file = path.basename(full);
    this.unregisterSource(file);
    try {
      delete require.cache[require.resolve(full)];
      this.registerModule(require(full), file);
      return true;
    } catch (err) {
      this.failures.set(file, err.message);
      this.logger && this.logger.error(`Skipped plugin ${file}:`, err.message);
      return false;
    }
  }

  loadBuiltins() {
    const dir = path.join(__dirname, 'builtin');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
      this.registerModule(require(path.join(dir, file)), `builtin/${file}`);
    }
  }

  /** User plugins run with full access to this computer, like any installed software. */
  loadUserPlugins(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const loaded = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
      if (this.loadUserPlugin(path.join(dir, file))) loaded.push(file);
    }
    return loaded;
  }

  /** Name -> where it comes from, for clash checks. */
  names(exceptSource = null) {
    const out = new Map();
    for (const [name, src] of this.sources) {
      if (src !== exceptSource) out.set(name, src.startsWith('builtin/') ? 'built in' : src);
    }
    return out;
  }

  has(name) { return this.tools.has(name); }

  /** Tool definitions for the API request, in a stable order. */
  definitions() {
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }

  list() {
    return [...this.tools.values()].map((t) => ({ name: t.name, source: this.sources.get(t.name), description: t.description }));
  }

  async run(name, input, ctx) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    const missing = (tool.input_schema.required || []).filter((k) => input[k] === undefined || input[k] === null);
    if (missing.length) throw new Error(`Missing required input: ${missing.join(', ')}`);
    return tool.run(input, ctx);
  }
}

function validate(def) {
  if (!def || typeof def !== 'object') return 'must export an object';
  if (!NAME_RE.test(def.name || '')) return 'name must match ^[a-z][a-z0-9_]{1,63}$';
  if (RESERVED.has(def.name)) return `name "${def.name}" is reserved`;
  if (typeof def.description !== 'string' || def.description.length < 10) return 'needs a description';
  if (!def.input_schema || def.input_schema.type !== 'object') return 'input_schema must be a JSON Schema object';
  if (typeof def.run !== 'function') return 'needs a run(input, ctx) function';
  return null;
}

module.exports = { PluginRegistry, validate };
