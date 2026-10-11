'use strict';
// Terminal page: real terminals (PowerShell, Command Prompt, Git Bash) as tabs next to Activity.
// The shells run in the main process (src/main/terminals.js); this draws them with xterm.js. The
// AI's own terminals appear here too, so every command it runs can be watched (and typed into).

(() => {
  const api = window.buddy;
  const $ = (id) => document.getElementById(id);
  const tablist = $('term-tablist');
  const shellsHost = $('term-shells');
  const menu = $('term-menu');
  const views = new Map(); // id -> { tab, view, term, fit, info }
  let active = 'activity';
  let shells = [];
  let opened = false;
  let focusWanted = null;

  const THEME = {
    background: '#0b0c0c', foreground: '#d6dcd9', cursor: '#3380ff', cursorAccent: '#0b0c0c',
    selectionBackground: 'rgba(51, 128, 255, 0.35)',
    black: '#1d2021', red: '#ff6369', green: '#34d399', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d6dcd9',
    brightBlack: '#6b736f', brightRed: '#ff8a8f', brightGreen: '#6ee7b7', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
  };
  const ICON_X = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>';

  // tabs
  function select(id) {
    active = id;
    document.querySelectorAll('#term-tabs .term-tab').forEach((t) => t.classList.toggle('active', String(t.dataset.tab) === String(id)));
    document.querySelector('.term-view[data-view="activity"]').hidden = id !== 'activity';
    for (const [vid, v] of views) v.view.hidden = vid !== id;
    const v = views.get(id);
    if (v) requestAnimationFrame(() => { fit(v); v.term.focus(); });
    renderUrls();
  }

  document.querySelector('.term-tab[data-tab="activity"]').addEventListener('click', () => select('activity'));

  function dotClass(info) {
    return `term-dot${info.owner === 'ai' ? ' ai' : ''}${info.busy ? ' busy' : ''}${info.exited ? ' ended' : ''}`;
  }

  function renderTab(v) {
    v.tab.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = dotClass(v.info);
    const label = document.createElement('span');
    label.textContent = v.info.name;
    const x = document.createElement('span');
    x.className = 'term-x';
    x.title = 'Close';
    x.innerHTML = ICON_X;
    x.addEventListener('click', (e) => { e.stopPropagation(); close(v.info.id); });
    v.tab.append(dot, label, x);
    v.tab.title = `${v.info.name}${v.info.owner === 'ai' ? ' (Bigfoot runs commands here)' : ''}${v.info.cwd ? ` · ${v.info.cwd}` : ''}`;
    v.ended.hidden = !v.info.exited;
    if (v.info.exited) v.ended.querySelector('span').textContent = `Ended (exit code ${v.info.exitCode}).`;
  }

  function renderUrls() {
    const box = $('term-urls');
    box.innerHTML = '';
    // Every running server's address, whichever tab is open (newest first).
    const urls = [...views.values()].filter((x) => !x.info.exited).flatMap((x) => x.info.urls).reverse();
    for (const url of [...new Set(urls)].slice(0, 4)) {
      const b = document.createElement('button');
      b.className = 'term-url';
      b.textContent = url.replace(/^https?:\/\//, '');
      b.title = `Open ${url} in the browser`;
      b.addEventListener('click', () => api.invoke('term:open-url', url));
      box.append(b);
    }
  }

  // one terminal
  function fit(v) {
    if (!v.view.offsetParent || !v.host.clientWidth) return; // hidden
    try {
      v.fit.fit();
      if (v.term.cols !== v.cols || v.term.rows !== v.rows) {
        v.cols = v.term.cols;
        v.rows = v.term.rows;
        api.send('term:resize', { id: v.info.id, cols: v.cols, rows: v.rows });
      }
    } catch { /* not laid out yet */ }
  }

  async function attach(info) {
    if (views.has(info.id)) return views.get(info.id);
    const tab = document.createElement('button');
    tab.className = 'term-tab';
    tab.dataset.tab = info.id;
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => select(info.id));
    tablist.append(tab);

    const view = document.createElement('div');
    view.className = 'term-view';
    view.hidden = true;
    const host = document.createElement('div');
    host.className = 'term-host';
    const ended = document.createElement('div');
    ended.className = 'term-ended';
    ended.hidden = true;
    ended.innerHTML = '<span></span>';
    const again = document.createElement('button');
    again.className = 'btn plain small';
    again.textContent = 'New terminal';
    again.addEventListener('click', () => create(info.shell));
    ended.append(again);
    view.append(host, ended);
    shellsHost.append(view);

    const term = new Terminal({
      theme: THEME, fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace", fontSize: 13, lineHeight: 1.2,
      cursorBlink: true, cursorStyle: 'bar', scrollback: 10000, allowProposedApi: true, convertEol: false,
      macOptionIsMeta: true, rightClickSelectsWord: false, smoothScrollDuration: 0,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, url) => api.invoke('term:open-url', url)));
    try { term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch { /* optional */ }
    term.open(host);
    const v = { info, tab, view, host, ended, term, fit: fitAddon, cols: 0, rows: 0 };
    views.set(info.id, v);

    // Typing goes straight to the shell. Ctrl+C copies when text is selected (else it interrupts),
    // Ctrl+V and Ctrl+Shift+V paste, as in Windows Terminal.
    term.onData((data) => api.send('term:input', { id: info.id, data }));
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const key = e.key.toLowerCase();
      if (e.ctrlKey && key === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
      if (e.ctrlKey && e.shiftKey && key === 'c') { if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()); return false; }
      if (e.ctrlKey && key === 'v') { navigator.clipboard.readText().then((t) => t && term.paste(t)); return false; }
      return true;
    });
    host.addEventListener('contextmenu', (e) => { // right-click: copy the selection, or paste
      e.preventDefault();
      if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); } else navigator.clipboard.readText().then((t) => t && term.paste(t));
    });
    new ResizeObserver(() => fit(v)).observe(host);

    const earlier = await api.invoke('term:replay', info.id); // what it showed before this window opened
    if (earlier) term.write(earlier);
    renderTab(v);
    return v;
  }

  async function create(shell = 'powershell') {
    menu.hidden = true;
    const info = await api.invoke('term:create', { shell, cols: 100, rows: 30 });
    const v = await attach(info);
    select(info.id);
    return v;
  }

  async function close(id) {
    await api.invoke('term:close', id);
    drop(id);
  }

  function drop(id) {
    const v = views.get(id);
    if (!v) return;
    v.term.dispose();
    v.tab.remove();
    v.view.remove();
    views.delete(id);
    if (active === id) select(views.size ? [...views.keys()].pop() : 'activity');
  }

  // new-terminal menu
  $('term-add').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menu.hidden) { menu.hidden = true; return; }
    menu.innerHTML = '';
    for (const s of shells) {
      const b = document.createElement('button');
      b.textContent = s.name;
      b.addEventListener('click', () => create(s.id));
      menu.append(b);
    }
    const r = $('term-add').getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4}px`;
    menu.hidden = false;
  });
  document.addEventListener('click', () => { menu.hidden = true; });

  // from the main process
  api.on('term:data', ({ id, data }) => { const v = views.get(id); if (v) v.term.write(data); });
  // "open the terminal" / "run … in the terminal": show that tab.
  api.on('term:focus', async (id) => {
    focusWanted = id;
    if (!opened) return; // the page opens it once it's shown
    const info = (await api.invoke('term:list')).find((i) => i.id === id);
    if (info) { await attach(info); select(id); }
  });
  api.on('term:list', async (list) => {
    for (const info of list) {
      const v = views.get(info.id) || await attach(info); // the AI opened one
      v.info = info;
      renderTab(v);
    }
    for (const id of [...views.keys()]) if (!list.some((i) => i.id === id)) drop(id);
    renderUrls();
  });

  // The first time the page is shown: the terminals that exist, or a fresh PowerShell.
  const pane = document.querySelector('[data-pane="terminal"]');
  async function shown() {
    if (pane.hidden) return;
    if (opened) { const v = views.get(active); if (v) requestAnimationFrame(() => fit(v)); return; }
    opened = true;
    shells = await api.invoke('term:shells');
    const list = await api.invoke('term:list');
    for (const info of list) await attach(info);
    if (focusWanted && views.has(focusWanted)) select(focusWanted);
    else if (!list.some((i) => i.owner === 'user')) await create(shells[0] ? shells[0].id : 'powershell');
    else select(list.filter((i) => i.owner === 'user').pop().id);
  }
  new MutationObserver(shown).observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  shown(); // already showing (the window opened on this page)
})();
