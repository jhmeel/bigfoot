'use strict';

const { shell } = require('electron');
const { spawn, execFile } = require('child_process');

const CACHE_MS = 5 * 60 * 1000;
let appsCache = null;

/** Start-menu apps (desktop and Store) via Get-StartApps. */
function startApps() {
  if (appsCache && Date.now() - appsCache.at < CACHE_MS) return Promise.resolve(appsCache.list);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
      let list = [];
      try {
        list = JSON.parse(stdout);
        if (!Array.isArray(list)) list = [list];
      } catch { /* leave empty; the PATH fallback still works */ }
      list = list.filter((a) => a && a.Name && a.AppID);
      if (list.length) appsCache = { at: Date.now(), list }; // never cache a failed lookup
      resolve(list);
    });
  });
}

const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Apps with a full web version, opened in the browser when the app itself isn't installed.
const WEB_APPS = {
  spotify: 'https://open.spotify.com', youtube: 'https://www.youtube.com', 'youtube music': 'https://music.youtube.com',
  netflix: 'https://www.netflix.com', whatsapp: 'https://web.whatsapp.com', telegram: 'https://web.telegram.org',
  gmail: 'https://mail.google.com', outlook: 'https://outlook.live.com', 'google docs': 'https://docs.google.com',
  'google sheets': 'https://sheets.google.com', 'google drive': 'https://drive.google.com', canva: 'https://www.canva.com',
  figma: 'https://www.figma.com', notion: 'https://www.notion.so', slack: 'https://app.slack.com', discord: 'https://discord.com/app',
  'microsoft teams': 'https://teams.microsoft.com', teams: 'https://teams.microsoft.com', 'apple music': 'https://music.apple.com',
  'prime video': 'https://www.primevideo.com', chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai',
};
const ALIASES = {
  chrome: 'google chrome', edge: 'microsoft edge', explorer: 'file explorer', files: 'file explorer',
  cmd: 'command prompt', vscode: 'visual studio code', 'vs code': 'visual studio code', paint: 'paint',
};

function scoreApp(query, name) {
  const q = normalize(ALIASES[normalize(query)] || query);
  const n = normalize(name);
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80 - (n.length - q.length) * 0.1;
  if (n.split(' ').includes(q)) return 70;
  if (n.includes(q)) return 60 - (n.length - q.length) * 0.1;
  const words = q.split(' ');
  const hits = words.filter((w) => n.includes(w)).length;
  return hits ? (40 * hits) / words.length : 0;
}

async function openApp(name) {
  const list = await startApps();
  const ranked = list.map((a) => ({ app: a, score: scoreApp(name, a.Name) })).sort((x, y) => y.score - x.score);
  const best = ranked[0];
  if (best && best.score >= 40) {
    await new Promise((resolve, reject) => {
      const child = spawn('explorer.exe', [`shell:AppsFolder\\${best.app.AppID}`], { windowsHide: true, detached: true, stdio: 'ignore' });
      child.on('error', reject);
      child.unref();
      setTimeout(resolve, 150);
    });
    return best.app.Name;
  }
  // Executables on PATH or registered App Paths, e.g. "notepad", "mspaint".
  if (!(await shell.openPath(name))) return name;
  const web = WEB_APPS[normalize(name)];
  if (web) {
    await shell.openExternal(web);
    return { web: true, name, url: web };
  }
  const close = ranked.filter((r) => r.score > 0).slice(0, 5).map((r) => r.app.Name);
  throw new Error(`No installed app matches "${name}".${close.length ? ` Closest: ${close.join(', ')}.` : ''}`);
}

module.exports = [
  {
    name: 'open_app',
    description: 'Open an installed Windows application by name (e.g. "Notepad", "Google Chrome", "Excel", "Settings", "Calculator"). Faster and more reliable than clicking through the Start menu.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'App name as it appears in the Start menu.' } },
      required: ['name'],
      additionalProperties: false,
    },
    async run({ name }, ctx) {
      await ctx.confirm('read', { title: 'Open an app?', message: `Open ${name}`, confirm: 'Open' });
      const opened = await openApp(String(name));
      await ctx.sleep(1200);
      if (opened && opened.web) {
        return `${opened.name} isn't installed on this PC, so its web version (${opened.url}) was opened in the browser instead. Tell the user, then take a screenshot to continue there.`;
      }
      return `Opened ${opened}. If you need to work in it next, take a screenshot first to see it.`;
    },
  },
  {
    name: 'open_url',
    description: 'Open a web address in the user\'s default browser.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full http(s) URL.' } },
      required: ['url'],
      additionalProperties: false,
    },
    async run({ url }, ctx) {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('Only http(s) URLs can be opened.');
      await ctx.confirm('read', { title: 'Open a website?', message: 'Open this address in your browser', detail: url, confirm: 'Open' });
      await shell.openExternal(url);
      await ctx.sleep(1200);
      return `Opened ${url} in the default browser.`;
    },
  },
];

module.exports.scoreApp = scoreApp;
module.exports.WEB_APPS = WEB_APPS;
