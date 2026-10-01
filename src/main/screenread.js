'use strict';
// Reads the screen as a list of its elements (buttons, links, boxes, menus, text) through Windows
// UI Automation, the way screen readers do: names, states and exact rectangles in about 0.3 s.
// The AI acts on elements by number and Bigfoot clicks their real centres, so nothing depends on
// a model guessing pixel positions from a screenshot (90 s per look on a PC without a graphics
// card). The local model reads about 10 words a second there, so it's shown only the elements
// that matter for the task, not all of them.

const KIND = {
  Button: 'button', SplitButton: 'button', Hyperlink: 'link', Edit: 'box', ComboBox: 'box', MenuItem: 'menu item',
  ListItem: 'item', TreeItem: 'item', DataItem: 'item', TabItem: 'tab', CheckBox: 'checkbox', RadioButton: 'option',
  Slider: 'slider', Spinner: 'number box', HeaderItem: 'column', Text: 'text', Image: 'image', Document: 'page',
};
const ACTIVE = new Set(['button', 'link', 'box', 'menu item', 'item', 'tab', 'checkbox', 'option', 'slider', 'number box', 'column']);
const WINDOW_BUTTONS = /^(?:minimize|maximize|restore)$/i;
const BROWSERS = /^(?:chrome|msedge|firefox|brave|opera|vivaldi|arc)$/i;
const STOP = new Set(('the a an and or to of in on at for with from into onto by is it this that these those my me you your please can could would will '
  + 'open click tap press select choose go find search look show type write enter put scroll down up then now also some any '
  + 'button link box page screen window app bigfoot hey okay ok want need like just').split(' '));

/** Lowercase words of 2+ letters, without filler words. */
function words(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));
}

const STATE_TEXT = { d: 'disabled', f: 'focused', c: 'checked', u: 'unchecked', x: 'collapsed', o: 'expanded', s: 'selected', p: 'password' };

class ScreenReader {
  /**
   * @param {object} deps
   *   input    InputHelper
   *   pointAt  async ({x, y, label}) => void, local dip on the target display (the buddy flies there)
   */
  constructor({ input, pointAt = async () => {}, pid = process.pid }) {
    this.input = input;
    this.pointAt = pointAt;
    this.pid = pid;
    this.latest = null; // the helper's current reading (its numbers are the ones actions use)
    this.shown = new Map(); // id → element, as last shown to the AI
  }

  /**
   * A browser builds its page's list only once something asks for it, so a page that has just
   * opened (or was never read) can come back nearly empty: read again for up to two seconds.
   * @param {import('./capture').ScreenTarget} target
   */
  async read(target) {
    let snap = await this.readOnce(target);
    for (let i = 0; i < 4 && BROWSERS.test(snap.app) && pageItems(snap) < 6; i++) {
      await sleep(500);
      snap = await this.readOnce(target);
    }
    return snap;
  }

  async readOnce(target) {
    const o = target.physOrigin;
    const raw = await this.input.send('uitree', this.pid, Math.round(o.x), Math.round(o.y),
      Math.round(o.x + target.phys.width), Math.round(o.y + target.phys.height), 500);
    const data = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const items = data.items.map((it, id) => {
      const [x, y, w, h] = it.r;
      return {
        id, type: it.t, kind: KIND[it.t] || null, name: String(it.n || '').trim(), value: String(it.v || '').trim(),
        rect: { x, y, w, h }, center: { x: x + w / 2, y: y + h / 2 },
        states: new Set(String(it.s || '')), invoke: String(it.s || '').includes('i'), writable: String(it.s || '').includes('w'),
      };
    });
    this.latest = { window: data.window, app: data.app, items, target, at: Date.now() };
    return this.latest;
  }

  /** The elements worth showing for this task, in reading order. */
  pick(snap, query = '', limit = 18) {
    const want = words(query);
    const kept = [];
    for (const it of snap.items) {
      if (!it.kind || it.kind === 'page') continue;
      if (!it.name && !(it.kind === 'box' && it.writable)) continue; // unnamed shapes say nothing
      if (it.kind === 'button' && WINDOW_BUTTONS.test(it.name)) continue;
      // The same thing exposed twice (a list item and the link inside it, a link and its text):
      // keep the one that can be acted on.
      const twin = kept.find((k) => k.name === it.name && inside(it.rect, k.rect, 6));
      if (twin) {
        if (rank(it) > rank(twin)) kept[kept.indexOf(twin)] = it;
        continue;
      }
      if (it.kind === 'text' || it.kind === 'image') {
        const owner = kept.find((k) => ACTIVE.has(k.kind) && inside(it.rect, k.rect, 4) && k.name.toLowerCase().includes(it.name.toLowerCase()));
        if (owner) continue;
      }
      kept.push(it);
    }
    // In a browser the page is what matters: its toolbar, tabs and extensions come after it.
    const page = biggestPage(snap);
    for (const it of kept) {
      it.outside = Boolean(page && !inside(it.rect, page.rect, 2) && !(it.kind === 'box' && it.writable));
    }
    for (const it of kept) {
      const hay = `${it.name} ${it.kind === 'box' ? it.value : ''}`.toLowerCase();
      it.match = want.filter((w) => hay.includes(w)).length;
      it.score = it.match * 4 + rank(it) + (it.states.has('f') ? 3 : 0) - (it.states.has('d') ? 1.5 : 0) - (it.outside ? 2.5 : 0);
    }
    const chosen = [...kept].sort((a, b) => b.score - a.score || a.id - b.id).slice(0, limit);
    return { list: chosen.sort((a, b) => readingOrder(a, b)), total: kept.length };
  }

  /**
   * The list as the AI reads it. point(sentXY) → [x, y] in the AI's own coordinates.
   * @returns {string}
   */
  describe(snap, query, { limit = 18, point = (p) => p } = {}) {
    const { list, total } = this.pick(snap, query, limit);
    this.shown = new Map(list.map((it) => [it.id, it]));
    const head = `On screen: "${clip(snap.window, 90)}"${snap.app ? ` (${snap.app})` : ''}.`;
    if (!list.length) {
      return `${head} No readable buttons or text here (a picture, game or canvas app). Use the computer tool's zoom to look at it.`;
    }
    const lines = list.map((it) => {
      const c = snap.target.physicalToSent(it.center);
      const [x, y] = point([c.x, c.y]).map(Math.round);
      let line = `[${it.id}] ${it.kind} "${clip(it.name, 80)}"`;
      if (it.kind === 'box' && it.value && it.value !== it.name) line += ` = "${clip(it.value, 60)}"`;
      if (it.kind === 'link' && it.value) { const host = hostOf(it.value); if (host) line += ` (${host})`; }
      const states = [...it.states].map((s) => STATE_TEXT[s]).filter(Boolean);
      if (states.length) line += ` (${states.join(', ')})`;
      return `${line} @${x},${y}`;
    });
    const more = total > list.length ? `\n(${total - list.length} more not shown: read_screen with find="words" finds others.)` : '';
    return `${head}\n${lines.join('\n')}${more}`;
  }

  /** Find an element the AI named by number, on a fresh reading (the screen may have moved since). */
  async locate(target, id) {
    const seen = this.shown.get(Number(id));
    if (!seen) throw new Error(`There's no element [${id}] in the latest list. Call read_screen first.`);
    const snap = await this.read(target);
    const same = snap.items.filter((it) => it.type === seen.type && it.name === seen.name);
    const near = (list) => list.sort((a, b) => dist(a.center, seen.center) - dist(b.center, seen.center))[0];
    let found = near(same);
    if (!found && !seen.name) found = near(snap.items.filter((it) => it.type === seen.type && dist(it.center, seen.center) < 40));
    if (!found) throw new Error(`[${id}] "${seen.name}" isn't on screen any more. Call read_screen to see what's there now.`);
    return { snap, item: found };
  }

  /** Where to aim: the element's live rectangle, scrolled into view if needed. */
  async aim(item) {
    let r = await this.act(item, 'rect');
    if (!r) {
      await this.act(item, 'scrollinto').catch(() => {});
      await sleep(300);
      r = await this.act(item, 'rect').catch(() => '');
    }
    if (!r) throw new Error(`"${item.name}" is hidden (off screen or covered). Scroll to it or open what contains it first.`);
    const [x, y, w, h] = r.split(',').map(Number);
    return { x: x + w / 2, y: y + h / 2, w, h };
  }

  act(item, action, arg = '') {
    return this.input.send('uiact', item.id, action, Buffer.from(String(arg), 'utf8').toString('base64'))
      .then((b64) => Buffer.from(b64, 'base64').toString('utf8'));
  }

  /** Move to a physical point the way the AI's mouse moves: the buddy flies there first. */
  async moveTo(target, phys, label) {
    const sent = target.physicalToSent(phys);
    try { await this.pointAt({ ...target.sentToLocalDip([sent.x, sent.y]), label }); } catch { /* still click */ }
    await this.input.move(phys.x, phys.y);
  }

  /** What changed between two readings, in a sentence the AI can act on. */
  static change(before, after) {
    if (before.window !== after.window) return `The window is now "${clip(after.window, 90)}".`;
    const sig = (s) => s.items.map((it) => `${it.type}:${it.name}:${it.value}:${[...it.states].join('')}`).join('|');
    if (sig(before) === sig(after)) return 'Nothing on screen changed, so that may not have worked. Try a different element or way.';
    const focus = after.items.find((it) => it.states.has('f') && it.kind && it.kind !== 'page');
    return `The screen changed${focus ? `; "${clip(focus.name || focus.value, 60)}" now has the focus` : ''}.`;
  }
}

/** The web page (or document) inside the window, if it fills a good part of it. */
function biggestPage(snap) {
  let best = null;
  for (const it of snap.items) {
    if (it.type !== 'Document' || it.rect.w < 300 || it.rect.h < 200) continue;
    if (!best || it.rect.w * it.rect.h > best.rect.w * best.rect.h) best = it;
  }
  return best;
}

function pageItems(snap) {
  const page = biggestPage(snap);
  return page ? snap.items.filter((it) => it !== page && it.kind && inside(it.rect, page.rect, 2)).length : 99;
}

/** Buttons, links and boxes come before the text that labels them. */
function rank(it) {
  if (it.kind === 'box') return it.writable ? 3 : 1.5;
  if (it.kind === 'button' || it.kind === 'link') return 2;
  if (ACTIVE.has(it.kind)) return 1.6;
  if (it.kind === 'text') return 0.6;
  return 0.3;
}

function readingOrder(a, b) {
  const rowA = Math.round(a.center.y / 24);
  const rowB = Math.round(b.center.y / 24);
  return rowA - rowB || a.center.x - b.center.x;
}

function inside(r, o, slack) {
  return r.x >= o.x - slack && r.y >= o.y - slack && r.x + r.w <= o.x + o.w + slack && r.y + r.h <= o.y + o.h + slack;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

module.exports = { ScreenReader, words };
