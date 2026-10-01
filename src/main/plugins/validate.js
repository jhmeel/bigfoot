'use strict';
// Checks a plugin file before it's installed: syntax, the tool contract, the input schemas, name
// clashes, and what the code can reach. The file is loaded in a separate, time-limited process so
// a broken or hostile plugin can't hang or crash Bigfoot during the check.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { validate: checkContract } = require('./registry');

const MAX_BYTES = 1024 * 1024;
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

const CAPABILITIES = [
  [/require\(\s*['"](?:node:)?child_process['"]\s*\)/, 'Run programs and commands'],
  [/require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/, 'Read, change, and delete files'],
  [/\bfetch\s*\(|require\(\s*['"](?:node:)?(?:https?|net|tls|dgram|http2)['"]\s*\)/, 'Connect to the internet'],
  [/require\(\s*['"]electron['"]\s*\)/, 'Use app features such as the clipboard and windows'],
  [/\beval\s*\(|new\s+Function\s*\(|require\(\s*['"](?:node:)?vm['"]\s*\)/, 'Run code it builds at runtime'],
  [/require\(\s*['"](?:node:)?os['"]\s*\)|process\.env/, 'Read system and account information'],
];

/** Problems with one tool's input_schema, as { errors, warnings }. */
function checkSchema(name, schema) {
  const errors = [];
  const warnings = [];
  const props = schema.properties || {};
  if (schema.properties !== undefined && (typeof props !== 'object' || Array.isArray(props))) {
    errors.push(`${name}: input_schema.properties must be an object.`);
    return { errors, warnings };
  }
  for (const key of schema.required || []) {
    if (!(key in props)) errors.push(`${name}: required input "${key}" isn't listed in properties.`);
  }
  for (const [key, p] of Object.entries(props)) {
    if (!p || typeof p !== 'object') { errors.push(`${name}: property "${key}" must be an object.`); continue; }
    if (p.type && !TYPES.has(p.type)) errors.push(`${name}: property "${key}" has unknown type "${p.type}".`);
    if (p.type === 'array' && !p.items) errors.push(`${name}: array property "${key}" needs "items".`);
    if (!p.description && !p.enum) warnings.push(`${name}: property "${key}" has no description, so the AI may misuse it.`);
  }
  return { errors, warnings };
}

function loadInChild(file, { execPath = process.execPath, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = path.join(__dirname, 'validate-child.js').replace('app.asar', 'app.asar.unpacked');
    execFile(execPath, [child, file], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => {
      const line = String(stdout || '').split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
      if (line) {
        try { return resolve(JSON.parse(line)); } catch { /* fall through */ }
      }
      resolve({ ok: false, error: err && err.killed ? `Loading took longer than ${timeoutMs / 1000} seconds.` : 'The plugin crashed while loading.' });
    });
  });
}

/**
 * @param {string} file
 * @param {{ existing?: Map<string, string>, source?: string }} opts  existing: tool name -> where it comes from
 * @returns {Promise<{ ok, file, tools, errors, warnings, capabilities }>}
 */
async function inspectPlugin(file, { existing = new Map(), execPath, timeoutMs } = {}) {
  const report = { ok: false, file, name: path.basename(file), tools: [], errors: [], warnings: [], capabilities: [] };
  let source;
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_BYTES) { report.errors.push('The file is larger than 1 MB. Plugins should be a single small script.'); return report; }
    source = await fs.promises.readFile(file, 'utf8');
  } catch {
    report.errors.push('The file can’t be read.');
    return report;
  }
  if (path.extname(file).toLowerCase() !== '.js') report.errors.push('Plugins must be .js files.');

  try {
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {\n${source}\n})`, { filename: file });
  } catch (err) {
    report.errors.push(`Syntax error: ${err.message}`);
    return report;
  }
  report.capabilities = CAPABILITIES.filter(([re]) => re.test(source)).map(([, label]) => label);

  const loaded = await loadInChild(file, { execPath, timeoutMs });
  if (!loaded.ok) { report.errors.push(loaded.error); return report; }
  if (!loaded.tools.length) { report.errors.push('The file doesn’t export any tools.'); return report; }

  const seen = new Set();
  for (const t of loaded.tools) {
    const def = { ...t, run: t.hasRun ? () => {} : undefined };
    const problem = checkContract(def);
    const label = t.name || '(unnamed tool)';
    if (problem) { report.errors.push(`${label}: ${problem}.`); continue; }
    if (seen.has(t.name)) report.errors.push(`${t.name}: defined twice in this file.`);
    if (existing.has(t.name)) report.errors.push(`${t.name}: a tool with this name already exists (${existing.get(t.name)}).`);
    seen.add(t.name);
    const schema = checkSchema(t.name, t.input_schema);
    report.errors.push(...schema.errors);
    report.warnings.push(...schema.warnings);
    if (!t.isAsync) report.warnings.push(`${t.name}: run() isn’t async; long work will freeze Bigfoot while it runs.`);
    if (t.description.length < 30) report.warnings.push(`${t.name}: the description is very short; say what the tool does and when to use it.`);
    report.tools.push({ name: t.name, description: t.description });
  }
  report.ok = report.errors.length === 0;
  return report;
}

module.exports = { inspectPlugin, checkSchema, CAPABILITIES };
