'use strict';
// Acting on the screen by element number, from the list read_screen gives (./screenread). Bigfoot
// finds the element again on a fresh reading and clicks its real centre, so the AI never has to
// guess positions; every result says what changed and lists the screen as it is now.

const { ScreenReader } = require('../../screenread');

const SETTLE_MS = 700;
const SEARCHY = /search|address|find|query|look ?up|url/i;

/** The screen after an action: what changed, then the current list. */
async function after(ctx, before, note = '') {
  await ctx.sleep(SETTLE_MS);
  const now = await ctx.ui.read(ctx.screen);
  const change = before ? ScreenReader.change(before, now) : '';
  const what = [note, change].filter(Boolean).join(' ');
  return `${what}\n${ctx.ui.describe(now, ctx.task, { limit: ctx.listLimit, point: ctx.modelPoint })}`.trim();
}

const ID = { type: 'integer', description: 'The element\'s number from the latest list, e.g. 12 for [12].' };

module.exports = [
  {
    name: 'read_screen',
    description: 'Read the screen as a numbered list of its elements: buttons, links, text boxes, tabs, menu items, checkboxes and text, with their state. Use the numbers with click_element, type_into, scroll_screen, drag_element and highlight_element. find="words" lists the elements matching those words, for something not in the list you have.',
    input_schema: {
      type: 'object',
      properties: { find: { type: 'string', description: 'Optional words to look for, e.g. "sign in" or "download".' } },
      additionalProperties: false,
    },
    async run(input, ctx) {
      const snap = await ctx.ui.read(ctx.screen);
      const query = input.find ? String(input.find) : ctx.task;
      return ctx.ui.describe(snap, query, { limit: input.find ? Math.min(ctx.listLimit, 15) : ctx.listLimit, point: ctx.modelPoint });
    },
  },
  {
    name: 'click_element',
    description: 'Click an element from the screen list by its number. how: "click" (default), "double" (open a file or folder), or "right" (context menu).',
    input_schema: {
      type: 'object',
      properties: { id: ID, how: { type: 'string', enum: ['click', 'double', 'right'] } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const { snap, item } = await ctx.ui.locate(ctx.screen, input.id);
      if (item.states.has('d')) throw new Error(`"${item.name}" is disabled (greyed out). Something else has to be done first.`);
      await ctx.confirm('read', { title: 'Allow this action?', message: `Click "${item.name || item.kind}"`, confirm: 'Allow' });
      await ctx.guard();
      const at = await ctx.ui.aim(item);
      await ctx.ui.moveTo(ctx.screen, at, input.how === 'right' ? 'right-clicking' : 'clicking here');
      await ctx.ui.input.click(input.how === 'right' ? 'right' : 'left', input.how === 'double' ? 2 : 1);
      return after(ctx, snap, `Clicked "${item.name || item.kind}".`);
    },
  },
  {
    name: 'type_into',
    description: 'Type text into a text box from the screen list, replacing what is in it. enter: true presses Enter afterwards (to search or submit). Never for passwords.',
    input_schema: {
      type: 'object',
      properties: { id: ID, text: { type: 'string' }, enter: { type: 'boolean' } },
      required: ['id', 'text'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const { snap, item } = await ctx.ui.locate(ctx.screen, input.id);
      if (item.states.has('p')) throw new Error('That is a password box. Ask the user to type their password themselves.');
      if (item.states.has('d')) throw new Error(`"${item.name}" is disabled.`);
      const text = String(input.text);
      const submit = Boolean(input.enter);
      // Enter submits forms; outside a search or address box that's a real action, so it's confirmed.
      await ctx.confirm(submit && !SEARCHY.test(item.name) ? 'change' : 'read', {
        title: 'Allow this action?', message: `Type "${text.slice(0, 60)}" into "${item.name || 'the box'}"${submit ? ' and press Enter' : ''}`, confirm: 'Allow',
      });
      await ctx.guard();
      const at = await ctx.ui.aim(item);
      await ctx.ui.moveTo(ctx.screen, at, 'typing here');
      await ctx.ui.input.click('left', 1);
      await ctx.sleep(120);
      await ctx.ui.input.keys('ctrl+a');
      await ctx.ui.input.type(text);
      // Check the box really holds the text before submitting it.
      let note = `Typed "${text.slice(0, 60)}" into "${item.name || 'the box'}".`;
      const value = await ctx.ui.act(item, 'value').catch(() => null);
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (value != null && value !== '' && !norm(value).includes(norm(text).slice(0, 40))) {
        note = `Typed, but the box shows "${value.slice(0, 80)}". Check it before going on.`;
      } else if (submit) {
        await ctx.ui.input.keys('enter');
        note += ' Pressed Enter.';
      }
      return after(ctx, snap, note);
    },
  },
  {
    name: 'scroll_screen',
    description: 'Scroll the page or a list up or down. id: an element to scroll inside (a list or the page); without it the front window scrolls. amount: how far, 1-15 (default 5, about half a page).',
    input_schema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer' }, id: ID },
      required: ['direction'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const dir = input.direction;
      const amount = Math.max(1, Math.min(Number(input.amount) || 5, 15));
      let snap;
      let at;
      if (input.id != null) {
        const found = await ctx.ui.locate(ctx.screen, input.id);
        snap = found.snap;
        at = await ctx.ui.aim(found.item);
      } else {
        snap = await ctx.ui.read(ctx.screen);
        // The page itself if there is one, else the middle of the screen.
        const page = snap.items.find((it) => it.type === 'Document' && it.rect.w > 200 && it.rect.h > 200);
        const o = ctx.screen.physOrigin;
        at = page ? page.center : { x: o.x + ctx.screen.phys.width / 2, y: o.y + ctx.screen.phys.height / 2 };
      }
      await ctx.guard();
      await ctx.ui.moveTo(ctx.screen, at, 'scrolling');
      await ctx.ui.input.scroll(dir === 'left' ? -amount : dir === 'right' ? amount : 0, dir === 'up' ? amount : dir === 'down' ? -amount : 0);
      return after(ctx, snap, `Scrolled ${dir}.`);
    },
  },
  {
    name: 'drag_element',
    description: 'Drag an element from the screen list onto another one (move a file into a folder, reorder items, move a window by its title bar).',
    input_schema: {
      type: 'object',
      properties: { id: ID, to: { type: 'integer', description: 'The number of the element to drop it on.' } },
      required: ['id', 'to'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const from = await ctx.ui.locate(ctx.screen, input.id);
      const dest = ctx.ui.shown.get(Number(input.to));
      if (!dest) throw new Error(`There's no element [${input.to}] in the latest list.`);
      const to = from.snap.items.filter((it) => it.type === dest.type && it.name === dest.name)
        .sort((a, b) => Math.hypot(a.center.x - dest.center.x, a.center.y - dest.center.y) - Math.hypot(b.center.x - dest.center.x, b.center.y - dest.center.y))[0];
      if (!to) throw new Error(`"${dest.name}" isn't on screen any more.`);
      await ctx.confirm('change', { title: 'Allow this action?', message: `Drag "${from.item.name}" onto "${to.name}"`, confirm: 'Allow' });
      await ctx.guard();
      const start = await ctx.ui.aim(from.item);
      const end = to.center;
      await ctx.ui.moveTo(ctx.screen, start, 'dragging from here');
      await ctx.ui.input.mouseDown('left');
      try {
        for (let i = 1; i <= 20; i++) {
          await ctx.ui.input.move(start.x + ((end.x - start.x) * i) / 20, start.y + ((end.y - start.y) * i) / 20);
          await ctx.sleep(15);
        }
      } finally {
        await ctx.ui.input.mouseUp('left');
      }
      return after(ctx, from.snap, `Dragged "${from.item.name}" onto "${to.name}".`);
    },
  },
  {
    name: 'highlight_element',
    description: 'Show the user an element from the screen list: draws a box around it with an optional short label.',
    input_schema: {
      type: 'object',
      properties: { id: ID, label: { type: 'string' }, color: { type: 'string', enum: ['blue', 'red', 'green', 'yellow', 'white'] } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const seen = ctx.ui.shown.get(Number(input.id));
      if (!seen) throw new Error(`There's no element [${input.id}] in the latest list. Call read_screen first.`);
      const pad = 6;
      const corner = (x, y) => {
        const s = ctx.screen.physicalToSent({ x, y });
        return ctx.screen.sentToLocalDip([Math.max(0, Math.min(s.x, ctx.screen.sent.width)), Math.max(0, Math.min(s.y, ctx.screen.sent.height))]);
      };
      const r = seen.rect;
      ctx.draw({
        shape: 'box',
        points: [corner(r.x - pad, r.y - pad), corner(r.x + r.w + pad, r.y + r.h + pad)],
        label: input.label ? String(input.label).slice(0, 120) : '',
        color: ['blue', 'red', 'green', 'yellow', 'white'].includes(input.color) ? input.color : 'blue',
        duration: 8,
      });
      return `Highlighted "${seen.name || seen.kind}" for the user.`;
    },
  },
];
