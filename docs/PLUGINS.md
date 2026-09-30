# Writing Bigfoot plugins

## What a plugin is

A plugin gives Bigfoot's AI a new **tool**: a function it can decide to call while it works on a
request. You describe the tool (a name, what it does, and the inputs it takes); when a request needs
it, the AI calls it with inputs it chose and uses what you return in its answer or its next step.

For example, with a `slack_post` plugin installed, "tell the team the build is green" makes the AI
call `slack_post({ channel: 'team', text: 'The build is green' })`.

Plugins are **not** apps or add-ons with their own screens: they don't add windows, menus, or
settings pages, and they don't run on their own. They run only when the AI calls them, with the same
access to the PC as Bigfoot.

## Kinds of plugins

| Kind | Examples | Usually needs |
|---|---|---|
| Services and APIs | weather, a Slack or Teams webhook, Notion, Jira, your company's API | `fetch` (internet) |
| Your data | search a folder of notes, a spreadsheet or database, internal documents | `fs` |
| Files and documents | bulk-rename, convert formats, extract or count text | `fs` |
| System utilities | clipboard, volume, battery, Wi-Fi status, window layout | `electron`, or `child_process` with PowerShell |
| Workflows | one tool for several steps: open a project, start a dev server, open its page | `child_process`, `shell` |
| Screen helpers | measure or mark things using the current screenshot | `ctx.screen`, `ctx.draw` |

Good plugins do one clear job, validate their inputs, ask before changing anything
(`ctx.confirm`), and return short, useful text. Prefer a plugin over asking the AI to click through
an app when an API or a file can do the job directly: it's faster and far more reliable.

## Adding one

In Settings › General › Plugins:

1. **Add Plugin…** opens at `plugins\template\plugin-template.js`, a documented starter plugin. It's
   read-only and always restored, so copy it, rename it, and edit the copy.
2. Choosing your plugin checks it before anything is installed: syntax, the tool definition, the
   input schema, and name clashes, with the plugin loaded in a separate, time-limited process. It
   then shows what the code can reach (run programs, files, the internet, …) and installs only when
   you confirm. The new tools are available from your next request; no restart needed.

Installed plugins live in `%APPDATA%\Bigfoot\plugins\`. Bigfoot's built-in tools are part of the app,
so they aren't in that folder. A file copied there by hand is loaded at the next start, and if it
fails, Settings shows why next to its name.

## The contract

A plugin module exports one tool, or an array of tools:

```js
module.exports = {
  name: 'word_count',                                   // ^[a-z][a-z0-9_]{1,63}$, unique
  description: 'Count the words in a text file. Use when the user asks how long a document is.',
  input_schema: {                                        // JSON Schema for the tool input
    type: 'object',
    properties: { path: { type: 'string', description: 'File to count.' } },
    required: ['path'],
  },
  async run(input, ctx) {
    await ctx.confirm('read', { title: 'Read this file?', message: 'Count the words in', detail: input.path });
    const text = require('fs').readFileSync(input.path, 'utf8');
    return `${text.split(/\s+/).filter(Boolean).length} words`;
  },
};
```

The model reads `description` and `input_schema` to decide when and how to call the tool, so write
them for the model: say what the tool does and when to use it.

`run` returns a string, or an array of content items:
`{ type: 'text', text }` and `{ type: 'image', data: '<base64 PNG>' }`.
Throw an `Error` to report a failure; its message is shown to the model.

## What `ctx` gives you

| Member | Use |
|---|---|
| `ctx.confirm(level, request)` | Ask the user before acting. `level` is `'read'` (asks only in "Every action" mode), `'change'` (asks unless approvals are off), or `'always'`. `request` is `{ title, message, detail, confirm, destructive }`. Throws if the user declines. |
| `ctx.signal` | An `AbortSignal` that fires when the user presses Esc. Pass it to long operations. |
| `ctx.log(kind, text)` | Write to the Bigfoot Terminal. Kinds: `info`, `stdout`, `stderr`, `command`. |
| `ctx.screen` | The screen being controlled: `screenshot()` returns a PNG `Buffer`, `sentToLocalDip([x, y])` maps screenshot coordinates. |
| `ctx.draw(shape)` | Draw on the overlay (same shapes as the built-in `annotate` tool). |
| `ctx.sleep(ms)` | A delay that ends early if the user stops the task. |
| `ctx.settings` | Read-only access to settings via `ctx.settings.get(name)`. |

## Rules

- Names must be unique and can't reuse `computer`, `screenshot`, `zoom`, `key`, `type`, `wait`, or `scroll`.
- Every input property needs a `type` and a `description`; array properties need `items`; every
  `required` name must be a property.
- `run` should be `async`. A file exports all of its tools or, if any is invalid, none of them.
- Adding or removing a plugin starts a new conversation, so the model sees the new tool list.
- Plugins run with the same access as Bigfoot itself. Only install plugins you wrote or trust.

A working example is in [`examples/plugins/clipboard.js`](../examples/plugins/clipboard.js).
