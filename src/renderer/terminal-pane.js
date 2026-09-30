'use strict';
// Terminal: the private, live log of everything Bigfoot does.

(async () => {
  const api = window.buddy;
  const $ = (id) => document.getElementById(id);
  const out = $('out');
  const LABEL = {
    task: 'task', think: 'think', action: 'action', command: '$', stdout: '', stderr: 'stderr',
    result: 'result', reply: 'reply', error: 'error', info: 'info',
  };
  let entries = [];
  let filter = '';
  const prompt = document.createElement('div');
  prompt.className = 'prompt';
  prompt.innerHTML = '<span class="cursor"></span>';



  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const matches = (e) => !filter || e.text.toLowerCase().includes(filter) || e.kind.includes(filter);

  function row(e) {
    const ln = document.createElement('div');
    ln.className = `ln ${e.kind}`;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = e.kind === 'stdout' ? '' : time(e.ts);
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = LABEL[e.kind] ?? e.kind;
    const tx = document.createElement('span');
    tx.className = 'tx';
    tx.textContent = e.kind === 'result' && e.text.length > 600 ? `${e.text.slice(0, 600)}… (${e.text.length.toLocaleString()} chars)` : e.text.replace(/\s+$/, '');
    ln.append(ts, k, tx);
    return ln;
  }

  function render() {
    out.textContent = '';
    const shown = entries.filter(matches);
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = entries.length ? 'No matching activity.' : 'Everything your assistant does appears here: what it saw, clicked, typed, and ran.';
      out.append(empty);
    } else {
      const frag = document.createDocumentFragment();
      shown.forEach((e) => frag.append(row(e)));
      out.append(frag);
    }
    out.append(prompt);
    $('count').textContent = `${entries.length.toLocaleString()} event${entries.length === 1 ? '' : 's'}`;
    scroll();
  }

  function scroll() { if ($('follow').checked) out.scrollTop = out.scrollHeight; }

  api.on('terminal:line', (e) => {
    entries.push(e);
    if (entries.length > 3000) entries.shift();
    $('count').textContent = `${entries.length.toLocaleString()} events`;
    if (!matches(e)) return;
    const empty = out.querySelector('.empty');
    if (empty) empty.remove();
    out.insertBefore(row(e), prompt);
    scroll();
  });

  $('filter').addEventListener('input', () => { filter = $('filter').value.trim().toLowerCase(); render(); });
  $('clear').addEventListener('click', async () => { await api.invoke('terminal:clear'); entries = []; render(); });
  $('reveal').addEventListener('click', () => api.invoke('terminal:reveal'));
  $('copy').addEventListener('click', async () => {
    const text = entries.filter(matches).map((e) => `${time(e.ts)}  ${(LABEL[e.kind] ?? e.kind).padEnd(7)} ${e.text}`).join('\n');
    await navigator.clipboard.writeText(text);
    $('copy').style.color = 'var(--success)';
    setTimeout(() => { $('copy').style.color = ''; }, 900);
  });

  entries = await api.invoke('terminal:get');
  render();
})();
