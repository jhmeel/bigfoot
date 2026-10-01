'use strict';
// Simple on-screen commands done straight away from the screen list, without the AI model:
// "click Sign in", "press the Search button", "scroll down", "go back", "press Enter". The
// element is found by its name; when it isn't clear which one is meant, the model decides.

const { core } = require('./intents');

const KEYS = {
  enter: 'enter', return: 'enter', escape: 'escape', esc: 'escape', tab: 'tab', space: 'space', backspace: 'backspace',
  delete: 'delete', home: 'home', end: 'end', 'page up': 'pageup', 'page down': 'pagedown', up: 'up', down: 'down', left: 'left', right: 'right',
};
const CLICKABLE = new Set(['button', 'link', 'tab', 'menu item', 'item', 'checkbox', 'option', 'column', 'box']);

/** @returns {{ kind: 'click'|'scroll'|'key'|'type', what?: string, dir?: string, amount?: number, keys?: string, text?: string, reply: string } | null} */
function matchUiCommand(text) {
  const t = core(text).replace(/^(?:now|then|and)\s+/i, '');
  if (!t || t.length > 80) return null;
  let m = /^(?:press|hit) (?:the )?(enter|return|escape|esc|tab|space|backspace|delete|home|end|page up|page down|up|down|left|right)(?: key)?$/i.exec(t);
  if (m) return { kind: 'key', keys: KEYS[m[1].toLowerCase()], reply: `Pressed ${m[1]}.` };
  m = /^scroll (up|down|left|right)(?: (?:a (?:bit|little)|more|again|some|a lot))?(?: on (?:the|this) page)?$/i.exec(t);
  if (m) return { kind: 'scroll', dir: m[1].toLowerCase(), amount: /a lot/i.test(t) ? 12 : /a (?:bit|little)/i.test(t) ? 3 : 6, reply: '' };
  if (/^go back(?: a page)?$/i.test(t)) return { kind: 'key', keys: 'alt+left', reply: 'Went back.' };
  if (/^go forward$/i.test(t)) return { kind: 'key', keys: 'alt+right', reply: 'Went forward.' };
  if (/^(?:refresh|reload)(?: (?:the|this) page)?$/i.test(t)) return { kind: 'key', keys: 'f5', reply: 'Reloaded the page.' };
  m = /^type ["“'](.+)["”']$/i.exec(t);
  if (m) return { kind: 'type', text: m[1], reply: '' };
  m = /^(?:click|tap|press|hit|select|choose|open)(?: on)? (?:the )?(.+?)(?: (?:button|link|tab|option|icon|menu|item|checkbox))?$/i.exec(t);
  if (m && m[1].length <= 50 && !/\b(?:and|then|after|first|second|third|last|next|every|all)\b/i.test(m[1])) {
    return { kind: 'click', what: m[1].replace(/^["“']|["”']$/g, ''), reply: '' };
  }
  return null;
}

/**
 * The one element a name means, or null if none or several fit equally well.
 * @param {{ items: object[] }} snap a reading from ./screenread
 */
function findElement(snap, what) {
  const want = String(what || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!want) return null;
  const scored = [];
  for (const it of snap.items) {
    if (!CLICKABLE.has(it.kind) || it.states.has('d')) continue;
    const name = it.name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!name) continue;
    let score = 0;
    if (name === want) score = 3;
    else if (name.startsWith(`${want} `) || name.endsWith(` ${want}`)) score = 2;
    else if (new RegExp(`(?:^|\\W)${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\W|$)`).test(name) && name.length <= want.length * 3) score = 1;
    if (score) scored.push({ it, score });
  }
  if (!scored.length) return null;
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best).map((s) => s.it);
  // The same control exposed twice (a list item and its link) is still one thing.
  const distinct = top.filter((a, i) => !top.slice(0, i).some((b) => Math.abs(a.center.x - b.center.x) < 12 && Math.abs(a.center.y - b.center.y) < 12));
  if (distinct.length !== 1) return null;
  // Prefer the part that acts (the link inside a list item).
  return top.sort((a, b) => Number(b.kind !== 'item') - Number(a.kind !== 'item'))[0];
}

module.exports = { matchUiCommand, findElement };
