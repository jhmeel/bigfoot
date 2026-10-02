'use strict';
// The AI's terminal: commands run in real PowerShell terminals (../../terminals.js) that the user can
// watch and type in on the Terminal page. One "Bigfoot" terminal keeps its folder and variables from
// command to command, like a person's; servers and watchers get a terminal of their own.

const fs = require('fs');
const os = require('os');
const { resolvePath, assertNotBigfoot } = require('../lib/paths');

const MAX_OUTPUT = 16000;
const READY = /\b(?:ready|listening|started|running|compiled|serving|local:|available on|press ctrl\+c)\b/i;

function clip(text) {
  const t = String(text || '').trim();
  if (t.length <= MAX_OUTPUT) return t || '(no output)';
  return `${t.slice(0, 2000)}\n… (${(t.length - MAX_OUTPUT).toLocaleString()} characters cut) …\n${t.slice(-(MAX_OUTPUT - 2000))}`;
}

function folder(input) {
  const cwd = input.working_directory ? resolvePath(input.working_directory) : null;
  if (cwd) assertNotBigfoot(cwd);
  if (cwd && !fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd} (create it first, e.g. with New-Item -ItemType Directory)`);
  return cwd;
}

/** The AI's own terminal, opened when first needed; a second one if it's still busy. */
function aiTerminal(ctx) {
  const t = ctx.terminals;
  const free = t.list().find((s) => s.owner === 'ai' && !s.exited && !s.busy && s.name === 'Bigfoot');
  if (free) return free;
  return t.create({ shell: 'powershell', name: 'Bigfoot', owner: 'ai' });
}

module.exports = [
  {
    name: 'run_command',
    description: 'Run a PowerShell command or script on the user\'s computer, in a real terminal the user can watch (Terminal page, "Bigfoot" tab). It keeps its folder between commands. Use it to write and run code, build projects, run tests, git, npm/pip and other tools. Waits for the command to finish and returns its exit code and output. For servers and anything that keeps running, use start_process.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command or script (several lines are fine).' },
        working_directory: { type: 'string', description: 'Folder to run in. Default: where the last command left off (first time: home folder).' },
        timeout_seconds: { type: 'number', description: '1-1800. Default 300.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const command = String(input.command).trim();
      if (!command) throw new Error('command is empty');
      const cwd = folder(input);
      await ctx.confirm('change', { title: 'Run this command?', message: cwd ? `In ${cwd}` : 'In the Bigfoot terminal', detail: command, confirm: 'Run' });
      ctx.log('command', command);
      const term = aiTerminal(ctx);
      const timeoutMs = Math.max(1, Math.min(Number(input.timeout_seconds) || 300, 1800)) * 1000;
      const r = await ctx.terminals.run(term.id, command, { cwd, timeoutMs, signal: ctx.signal });
      if (r.output) ctx.log('stdout', r.output.slice(-4000));
      if (!r.done) {
        return `Still running after ${timeoutMs / 1000}s in terminal ${term.id}. Its output so far:\n${clip(r.output)}\n(Read more with terminal action "read", or stop it with action "stop".)`;
      }
      return `Exit code ${r.exitCode}\n${clip(r.output)}`;
    },
  },
  {
    name: 'start_process',
    description: 'Start something that keeps running, in a new terminal tab of its own: a dev server (npm run dev, python -m http.server, flask run…), a watcher, a bot. Returns once it reports it is ready, with any localhost address it printed (open it with open_url). It keeps running; use the terminal tool to read its output or stop it.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command that starts it.' },
        working_directory: { type: 'string', description: 'The project folder.' },
        name: { type: 'string', description: 'Short tab name, e.g. "Vite server".' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const command = String(input.command).trim();
      if (!command) throw new Error('command is empty');
      const cwd = folder(input) || os.homedir();
      await ctx.confirm('change', { title: 'Start this?', message: `In ${cwd}`, detail: command, confirm: 'Start' });
      ctx.log('command', command);
      const term = ctx.terminals.create({ shell: 'powershell', name: String(input.name || command.split(/\s+/).slice(0, 3).join(' ')).slice(0, 40), owner: 'ai', cwd });
      await ctx.terminals.ready(term.id); // typed before the prompt, the line comes out garbled
      ctx.terminals.write(term.id, `${command}\r`);
      // Wait for an address, a "ready" line, an exit, or 30 s, whichever comes first.
      const started = Date.now();
      let info = term;
      while (Date.now() - started < 30000) {
        await ctx.sleep(500);
        info = ctx.terminals.list().find((s) => s.id === term.id) || info;
        if (info.exited || info.urls.length) break;
        const out = ctx.terminals.tail(term.id, 15);
        if (Date.now() - started > 3000 && READY.test(out)) break;
      }
      const out = clip(ctx.terminals.tail(term.id, 40));
      if (info.exited) return `It stopped (exit code ${info.exitCode}) in terminal ${term.id}:\n${out}`;
      const urls = info.urls.length ? `\nAddress: ${info.urls.join(', ')}` : '';
      return `Running in terminal ${term.id} ("${info.name}").${urls}\nOutput so far:\n${out}`;
    },
  },
  {
    name: 'terminal',
    description: 'The terminals: action "list" (each with its number, what runs in it and any localhost address), "read" (the latest output of terminal id), "stop" (Ctrl+C in terminal id), "close" (end terminal id).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'stop', 'close'] },
        id: { type: 'integer', description: 'The terminal\'s number (for read, stop and close).' },
        lines: { type: 'integer', description: 'For read: how many lines, 1-400. Default 80.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const t = ctx.terminals;
      if (input.action === 'list') {
        const list = t.list();
        if (!list.length) return 'No terminals are open.';
        return list.map((s) => `${s.id}. ${s.name} (${s.shell}${s.owner === 'ai' ? ', yours' : ', the user\'s'})${s.exited ? ` ended, exit ${s.exitCode}` : s.busy ? ' busy' : ' open'}${s.urls.length ? ` ${s.urls.join(' ')}` : ''}`).join('\n');
      }
      if (input.id == null) throw new Error('id is needed');
      if (input.action === 'read') return clip(t.tail(input.id, Number(input.lines) || 80));
      if (input.action === 'stop') {
        t.interrupt(input.id);
        await ctx.sleep(800);
        return `Sent Ctrl+C to terminal ${input.id}. Latest output:\n${clip(t.tail(input.id, 15))}`;
      }
      if (input.action === 'close') {
        await ctx.confirm('change', { title: 'Close this terminal?', message: `Terminal ${input.id}`, confirm: 'Close' });
        t.close(input.id);
        return `Closed terminal ${input.id}.`;
      }
      throw new Error(`Unknown action ${input.action}`);
    },
  },
];
