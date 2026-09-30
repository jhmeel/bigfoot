'use strict';

const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { resolvePath, assertWritable } = require('../lib/paths');

const MAX_READ = 60000;
const MAX_LIST = 400;
const RUNNABLE = /\.(exe|bat|cmd|ps1|msi|vbs|js|jar|com|scr|lnk|appref-ms)$/i;
const pathSchema = (extra = {}) => ({
  type: 'object',
  properties: { path: { type: 'string', description: 'Absolute path, ~, %ENV%, or Desktop/Documents/Downloads/... shortcuts.' }, ...extra },
  required: ['path'],
  additionalProperties: false,
});

module.exports = [
  {
    name: 'list_directory',
    description: 'List files and folders in a directory.',
    input_schema: pathSchema(),
    async run(input, ctx) {
      const dir = resolvePath(input.path);
      await ctx.confirm('read', { title: 'Look in this folder?', message: 'List the files in', detail: dir, confirm: 'Allow' });
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const rows = entries.slice(0, MAX_LIST).map((e) => {
        if (e.isDirectory()) return `[dir] ${e.name}`;
        try {
          return `      ${e.name}  ${fs.statSync(path.join(dir, e.name)).size.toLocaleString()} bytes`;
        } catch {
          return `      ${e.name}`;
        }
      });
      const more = entries.length > MAX_LIST ? `\n… and ${entries.length - MAX_LIST} more` : '';
      return `${dir}\n${rows.join('\n') || '(empty)'}${more}`;
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file (up to about 60 KB).',
    input_schema: pathSchema(),
    async run(input, ctx) {
      const file = resolvePath(input.path);
      await ctx.confirm('read', { title: 'Read this file?', message: 'Read the contents of', detail: file, confirm: 'Allow' });
      const st = fs.statSync(file);
      if (st.isDirectory()) throw new Error(`${file} is a folder. Use list_directory.`);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, MAX_READ));
        fs.readSync(fd, buf, 0, buf.length, 0);
        if (buf.includes(0)) throw new Error(`${file} is a binary file, so it can't be read as text.`);
        return `${file} (${st.size.toLocaleString()} bytes${st.size > MAX_READ ? ', showing the start' : ''})\n${buf.toString('utf8')}`;
      } finally {
        fs.closeSync(fd);
      }
    },
  },
  {
    name: 'write_file',
    description: 'Create a text file, or replace one when overwrite is true. Missing folders are created.',
    input_schema: pathSchema({
      content: { type: 'string' },
      overwrite: { type: 'boolean', description: 'Must be true to replace an existing file. Check with the user first.' },
    }),
    async run(input, ctx) {
      const file = resolvePath(input.path);
      assertWritable(file);
      const exists = fs.existsSync(file);
      if (exists && fs.statSync(file).isDirectory()) throw new Error(`${file} is a folder.`);
      if (exists && !input.overwrite) throw new Error(`${file} already exists. Set overwrite to true to replace it, after checking with the user.`);
      const content = String(input.content ?? '');
      await ctx.confirm(exists ? 'change' : 'read', {
        title: exists ? 'Replace this file?' : 'Create this file?',
        message: exists ? 'Its current contents will be replaced.' : `A new file with ${content.length.toLocaleString()} characters`,
        detail: file,
        confirm: exists ? 'Replace' : 'Create',
        destructive: exists,
      });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return `${exists ? 'Replaced' : 'Created'} ${file}`;
    },
  },
  {
    name: 'create_folder',
    description: 'Create a folder, including any missing parent folders.',
    input_schema: pathSchema(),
    async run(input, ctx) {
      const dir = resolvePath(input.path);
      assertWritable(dir);
      await ctx.confirm('read', { title: 'Create this folder?', message: 'Create a new folder', detail: dir, confirm: 'Create' });
      fs.mkdirSync(dir, { recursive: true });
      return `Created ${dir}`;
    },
  },
  {
    name: 'delete_path',
    description: 'Move a file or folder to the Recycle Bin. The user is always asked to confirm.',
    input_schema: pathSchema(),
    async run(input, ctx) {
      const target = resolvePath(input.path);
      assertWritable(target);
      if (!fs.existsSync(target)) throw new Error(`${target} doesn't exist.`);
      const kind = fs.statSync(target).isDirectory() ? 'folder' : 'file';
      await ctx.confirm('always', {
        title: `Move this ${kind} to the Recycle Bin?`,
        message: 'You can restore it from the Recycle Bin later.',
        detail: target,
        confirm: 'Move to Recycle Bin',
        destructive: true,
      });
      await shell.trashItem(target);
      return `Moved ${target} to the Recycle Bin.`;
    },
  },
  {
    name: 'open_path',
    description: 'Open a file with its default app, run a program, or open a folder in File Explorer.',
    input_schema: pathSchema(),
    async run(input, ctx) {
      const target = resolvePath(input.path);
      if (!fs.existsSync(target)) throw new Error(`${target} doesn't exist.`);
      const runnable = RUNNABLE.test(target);
      await ctx.confirm(runnable ? 'change' : 'read', {
        title: runnable ? 'Run this program?' : 'Open this?',
        message: runnable ? 'This will start a program.' : 'Open with its default app',
        detail: target,
        confirm: runnable ? 'Run' : 'Open',
      });
      const err = await shell.openPath(target);
      if (err) throw new Error(err);
      await ctx.sleep(1000);
      return `Opened ${target}`;
    },
  },
];
