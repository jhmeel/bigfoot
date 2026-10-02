'use strict';
// Everyday commands done straight away, without the AI model: "search for …", "open Chrome and
// search …", "play … on YouTube", "go to amazon.com", "open Spotify". On a laptop without a
// graphics card each look at the screen costs the model a minute or more; these need none, and
// they use the same tools the model would. Anything not clearly one of these goes to the model.

const SITES = {
  youtube: 'https://www.youtube.com', gmail: 'https://mail.google.com', 'google maps': 'https://maps.google.com',
  maps: 'https://maps.google.com', google: 'https://www.google.com', facebook: 'https://www.facebook.com',
  instagram: 'https://www.instagram.com', twitter: 'https://x.com', x: 'https://x.com', linkedin: 'https://www.linkedin.com',
  netflix: 'https://www.netflix.com', amazon: 'https://www.amazon.com', wikipedia: 'https://www.wikipedia.org',
  reddit: 'https://www.reddit.com', 'chat gpt': 'https://chatgpt.com', chatgpt: 'https://chatgpt.com',
  'google drive': 'https://drive.google.com', 'google docs': 'https://docs.google.com',
};
const BROWSERS = '(?:google chrome|chrome|microsoft edge|edge|firefox|the browser|my browser|a browser|browser|google)';
const enc = (q) => encodeURIComponent(q.trim()).replace(/%20/g, '+');

/** Strip the polite and addressing parts: "Hey Bigfoot, can you please …" → "…". */
function core(text) {
  return String(text || '').trim()
    .replace(/^(?:hey|hi|ok(?:ay)?)?\s*,?\s*(?:big\s?foot|bigfoot)\s*[,.!]?\s*/i, '')
    .replace(/^(?:can|could|would|will) you\s+(?:please\s+)?/i, '')
    .replace(/^(?:please|kindly|i want you to|i need you to|help me(?: to)?|go ahead and)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const NEXT_STEP = /\s*(?:,\s*)?(?:and then|and|then)\s+(?=(?:browse|open|click|show|tell|read|check|look|go|see|book|order|compare|select|choose|pick|get|list|summari[sz]e|call|reserve|scroll|view|download|save|play|listen|watch)\b)/i;
function splitFollowUp(s) {
  const m = NEXT_STEP.exec(s);
  return m ? [s.slice(0, m.index).trim(), s.slice(m.index + m[0].length).trim()] : [s.trim(), null];
}

/** @returns {{ calls: {name: string, input: object}[], reply: string, followUp?: string|null } | null} */
function matchIntent(text) {
  const t = core(text);
  if (!t || t.length > 160) return null;
  let m;

  // play … on youtube / search youtube for …
  m = /^(?:open youtube and )?(?:play|watch|search youtube for|search on youtube for|find on youtube) (.+?)(?: on youtube| in youtube)?$/i.exec(t);
  if (m && (/youtube/i.test(t) || /^(?:play|watch) /i.test(t)) && !/spotify|music app/i.test(t)) {
    return { calls: [{ name: 'open_url', input: { url: `https://www.youtube.com/results?search_query=${enc(m[1])}` } }], reply: `Searching YouTube for ${m[1]}.` };
  }

  // [open chrome and] search [google] for … / google … / look up …
  m = new RegExp(`^(?:(?:open|launch|start|use) ${BROWSERS}\\s*(?:,|and|then|and then)?\\s*)?(?:search(?: google| the web| online)?(?: for)?|google|look up|find me|find|browse(?: the web| online)?(?: for)?) (.+?)(?: on (?:google|chrome|the web|the internet|online))?$`, 'i').exec(t);
  if (m && !/\b(?:file|folder|document|on (?:my|this) (?:pc|computer|laptop))\b/i.test(m[1])) {
    // "… and browse their menu": search now, then the model carries on from the results page.
    const [query, rest] = splitFollowUp(m[1]);
    // Songs and films usually aren't free to download: the model gets them playing instead.
    const media = rest && /\b(?:download|save)\b/i.test(rest) && /\b(?:songs?|music|albums?|tracks?|mp3|movies?|films?|videos?|episodes?)\b/i.test(t);
    const legal = media ? ' Only download it from a site that offers it free and legally, such as the artist\'s own page; otherwise play it on YouTube or a streaming site and say why it was not downloaded.' : '';
    return {
      calls: [{ name: 'open_url', input: { url: `https://www.google.com/search?q=${enc(query)}` } }],
      reply: `Searching Google for ${query}.`,
      followUp: rest ? `${rest} (A Google search for "${query}" is already open in the browser: continue from those results.${legal})` : null,
    };
  }

  // go to / open / visit a web address
  m = /^(?:open|go to|visit|take me to|browse to|navigate to) ((?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?)$/i.exec(t);
  if (m) {
    const url = /^https?:\/\//i.test(m[1]) ? m[1] : `https://${m[1]}`;
    return { calls: [{ name: 'open_url', input: { url } }], reply: `Opening ${m[1]}.` };
  }

  // open a well-known site by name
  m = /^(?:open|go to|visit|take me to|launch) (.+)$/i.exec(t);
  if (m && SITES[m[1].toLowerCase()]) return { calls: [{ name: 'open_url', input: { url: SITES[m[1].toLowerCase()] } }], reply: `Opening ${m[1]}.` };

  // open an app (one app, nothing else asked)
  m = /^(?:open|launch|start|run) (?:the |my )?([a-z0-9][\w .+&'-]{1,38}?)(?: app| application| program)?$/i.exec(t);
  if (m && (/^file explorer$/i.test(m[1]) || !/\b(?:and|then|to|with|for|in|on|file|folder|it|this|that)\b/i.test(m[1]))) {
    return { calls: [{ name: 'open_app', input: { name: m[1] } }], reply: `Opening ${m[1]}.` };
  }
  return null;
}

const SHELLS = { powershell: 'powershell', 'power shell': 'powershell', cmd: 'cmd', 'command prompt': 'cmd', 'git bash': 'bash', bash: 'bash' };
const TERMINAL = "(?:the |my |a |bigfoot'?s? |your )?(?:terminal|console|command line)";

/**
 * "the terminal" is Bigfoot's own (the Terminal page): "open the terminal", "open PowerShell",
 * "run npm install in the terminal". Done straight away, no model.
 * @returns {{ kind: 'open', shell: string|null } | { kind: 'run', command: string } | null}
 */
function matchTerminal(text) {
  const t = core(text);
  if (!t || t.length > 300) return null;
  let m = new RegExp(`^(?:open|show|go to|bring up|launch|start)(?: up)? ${TERMINAL}(?: page| window| tab)?$`, 'i').exec(t);
  if (m) return { kind: 'open', shell: null };
  m = /^(?:open|launch|start)(?: a| the| new)* (powershell|power shell|cmd|command prompt|git bash|bash)(?: tab| window| terminal)?$/i.exec(t);
  if (m) return { kind: 'open', shell: SHELLS[m[1].toLowerCase()] };
  m = new RegExp(`^(?:run|execute|type|enter)(?: the command)? (.+?) (?:in|on|inside) ${TERMINAL}$`, 'i').exec(t)
    || new RegExp(`^(?:in|on) ${TERMINAL},? (?:run|execute|type|enter)(?: the command)? (.+)$`, 'i').exec(t);
  if (!m || !m[1].trim()) return null;
  // Quotes around the whole command are the user's, not part of it ("type "dir" in the terminal");
  // quotes inside it are kept (node -e "console.log(1)").
  const command = m[1].trim();
  const wrapped = /^(["“'`])(.*)(["”'`])$/.exec(command);
  const inner = wrapped && wrapped[2];
  return { kind: 'run', command: inner && !/["“”'`]/.test(inner) ? inner : command };
}

module.exports = { matchIntent, matchTerminal, core };
