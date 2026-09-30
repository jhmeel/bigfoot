'use strict';
// Example plugin: read and write the clipboard directly, which is faster and more reliable than
// selecting text and pressing Ctrl+C. Copy this file into %APPDATA%\Bigfoot\plugins and restart.

const { clipboard } = require('electron');

module.exports = [
  {
    name: 'clipboard_read',
    description: 'Read the text currently on the clipboard. Use after copying something, or when the user refers to what they copied.',
    input_schema: { type: 'object', properties: {}, required: [] },
    async run(_input, ctx) {
      await ctx.confirm('read', { title: 'Read your clipboard?', message: 'Bigfoot wants to read the copied text.', confirm: 'Allow' });
      const text = clipboard.readText();
      return text ? `Clipboard:\n${text.slice(0, 20000)}` : 'The clipboard has no text.';
    },
  },
  {
    name: 'clipboard_write',
    description: 'Put text on the clipboard so it can be pasted with Ctrl+V. Good for moving long text between apps.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to copy.' } },
      required: ['text'],
    },
    async run({ text }, ctx) {
      await ctx.confirm('read', { title: 'Replace your clipboard?', message: `Copy ${text.length.toLocaleString()} characters`, confirm: 'Copy' });
      clipboard.writeText(String(text));
      ctx.log('info', `Copied ${text.length} characters to the clipboard.`);
      return 'Copied to the clipboard.';
    },
  },
];
