'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const { resolvePath } = require('../lib/paths');

const MAX_OUTPUT = 20000;

function killTree(pid) {
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
}

function runPowerShell(command, { cwd, timeoutMs, signal, log }) {
  return new Promise((resolve) => {
    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${command}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let truncated = false;
    const take = (stream) => (chunk) => {
      const text = chunk.toString('utf8');
      log(stream, text);
      if (out.length < MAX_OUTPUT) out += text;
      else truncated = true;
    };
    child.stdout.on('data', take('stdout'));
    child.stderr.on('data', take('stderr'));

    const timer = setTimeout(() => { out += `\n[Timed out after ${timeoutMs / 1000}s and was stopped.]`; killTree(child.pid); }, timeoutMs);
    const onAbort = () => { out += '\n[Stopped by the user.]'; killTree(child.pid); };
    signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => { out += `\n[Could not start PowerShell: ${err.message}]`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const body = out.slice(0, MAX_OUTPUT).trimEnd() || '(no output)';
      resolve(`Exit code ${code}${truncated ? ' (output truncated)' : ''}\n${body}`);
    });
  });
}

module.exports = {
  name: 'run_command',
  description: 'Run a PowerShell command on the user\'s computer and return its output. Use for work that is simpler from a terminal: running programs or scripts, git, package managers the user asked for, system queries. The user sees every command in the Bigfoot Terminal and may be asked to approve it. Commands are non-interactive; avoid anything that waits for input.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'PowerShell command or script.' },
      working_directory: { type: 'string', description: 'Folder to run in. Defaults to the user\'s home folder.' },
      timeout_seconds: { type: 'number', description: '1-600. Default 120.' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const command = String(input.command).trim();
    if (!command) throw new Error('command is empty');
    const cwd = input.working_directory ? resolvePath(input.working_directory) : os.homedir();
    if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
    await ctx.confirm('change', { title: 'Run this command?', message: `In ${cwd}`, detail: command, confirm: 'Run' });
    ctx.log('command', command);
    return runPowerShell(command, {
      cwd,
      timeoutMs: Math.max(1, Math.min(Number(input.timeout_seconds) || 120, 600)) * 1000,
      signal: ctx.signal,
      log: ctx.log,
    });
  },
};
