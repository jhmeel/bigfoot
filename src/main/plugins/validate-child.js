'use strict';
// Runs in a separate process (ELECTRON_RUN_AS_NODE): loads one plugin and reports what it exports.

const out = (o) => process.stdout.write(`\n${JSON.stringify(o)}\n`);

try {
  const mod = require(process.argv[2]);
  const defs = Array.isArray(mod) ? mod : [mod];
  out({
    ok: true,
    tools: defs.map((d) => ({
      name: d && d.name,
      description: d && d.description,
      input_schema: d && d.input_schema,
      hasRun: Boolean(d && typeof d.run === 'function'),
      isAsync: Boolean(d && typeof d.run === 'function' && d.run.constructor && d.run.constructor.name === 'AsyncFunction'),
    })),
  });
} catch (err) {
  out({ ok: false, error: `The plugin threw while loading: ${(err && err.message) || err}` });
}
process.exit(0);
