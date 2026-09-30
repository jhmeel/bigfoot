'use strict';

const TEMPLATE = `'use strict';
// WHAT A PLUGIN IS
// A plugin gives Bigfoot's AI a new tool: a function it can decide to call while helping you.
// You describe the tool (name, description, inputs); when a request needs it, the AI calls run()
// with the inputs it chose and uses whatever you return. Plugins don't add windows or menus and
// don't run on their own; they run only when the AI calls them, with the access Bigfoot has.
//
// KINDS OF PLUGINS YOU CAN BUILD
//   Services and APIs   weather, a Slack/Teams webhook, Notion, Jira, your company's API (fetch)
//   Your data           search a folder of notes, a CSV or database, internal docs
//   Files and documents bulk-rename, convert formats, count or extract text (fs)
//   System utilities    clipboard, volume, battery, Wi-Fi, window layout (child_process + PowerShell)
//   Workflows           one tool that does several steps: open a project, start a server, open a URL
//   Screen helpers      measure or mark things using ctx.screen.screenshot() and ctx.draw()
//
// HOW TO MAKE YOURS
// This file is read-only and always kept here. Copy it (for example to your Documents folder),
// rename and edit the copy, then choose it in Settings › General › Plugins › Add Plugin…
// It's checked before it's installed, and you'll see what the code can access.
// The AI reads "description" and "input_schema" to decide when and how to use the tool, so say
// what it does and when it's useful. Full guide: README.txt in the plugins folder.

module.exports = {
  // Lowercase letters, digits and underscores; must be unique.
  name: 'word_count',

  description: 'Count the words in a text file. Use when the user asks how long a document is.',

  // JSON Schema for the tool's input. Every property needs a type and a description.
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Full path of the text file to count.' },
    },
    required: ['path'],
  },

  // Runs when the AI calls the tool. Return a string (or throw an Error to report a problem).
  async run(input, ctx) {
    // Ask the user before touching anything of theirs. Throws if they decline.
    await ctx.confirm('read', { title: 'Read this file?', message: 'Count the words in', detail: input.path });

    const text = await require('fs').promises.readFile(input.path, 'utf8');
    const words = text.split(/\\s+/).filter(Boolean).length;
    ctx.log('info', \`Counted \${words} words in \${input.path}\`);
    return \`\${words} words\`;
  },
};
`;

const README = `Bigfoot plugins
===============

A plugin gives Bigfoot's AI a new tool: a function it can call while helping you, such as
posting to a Slack channel, searching your notes, converting files, or reading the battery level.
Plugins don't add windows or menus and don't run on their own; the AI calls them when a request
needs them.

Plugins you add in Settings › General › Plugins are stored here. Bigfoot's built-in tools
(drawing, apps and websites, files, commands) are part of the app and aren't in this folder.

Kinds of plugins
  Services and APIs    weather, chat webhooks, Notion, Jira, your own APIs
  Your data            search notes, spreadsheets, databases, internal documents
  Files and documents  rename in bulk, convert formats, extract or count text
  System utilities     clipboard, volume, battery, Wi-Fi, window layout
  Workflows            several steps as one tool (open a project, start a server, open a page)
  Screen helpers       measure or mark things on screen

Adding a plugin
  1. template\plugin-template.js is a documented starter plugin (read-only; it's always restored).
     Copy it, rename it, and edit the copy.
  2. Settings › General › Plugins › Add Plugin… opens at the template. Choose your plugin: it's
     checked (syntax, the tool definition, its input schema, name clashes) in a separate process,
     you see what the code can access, and it's installed only if you confirm.

Rules
  - A plugin exports one tool, or an array of tools: { name, description, input_schema, run }.
  - name: lowercase letters, digits and underscores, unique across all tools.
  - run(input, ctx) should be async and return a string, or throw an Error.
  - ctx.confirm(level, request) asks the user first: level 'read', 'change' or 'always'.
  - ctx.signal fires when the user presses Esc; ctx.log(kind, text) writes to the Bigfoot Terminal.
  - Plugins run with the same access as Bigfoot. Only add plugins you wrote or trust.

Files dropped here by hand are loaded at the next start; if one fails, Settings shows why.
`;

module.exports = { TEMPLATE, README };
