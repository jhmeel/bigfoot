'use strict';
// Home: status, conversation, and the request composer.

(() => {
  const api = window.buddy;
  const $ = (id) => document.getElementById(id);
  const STATES = {
    idle: ['Ready', 'ok'], listening: ['Listening…', 'busy'], processing: ['Thinking…', 'busy'],
    acting: ['Working…', 'busy'], responding: ['Talking…', 'busy'],
  };
  let running = false;
  let lastProgress = null;

  function setState(s) {
    const [text, cls] = STATES[s] || STATES.idle;
    $('status-text').textContent = text;
    $('status').className = `status ${cls}`;
    running = s === 'processing' || s === 'acting';
    document.body.classList.toggle('running', running);
    updateSend();
  }

  function updateSend() {
    $('send').disabled = !running && !$('prompt').value.trim();
    $('send').title = running ? 'Stop (Esc)' : 'Send (Enter)';
    $('send').setAttribute('aria-label', running ? 'Stop' : 'Send');
  }

  function addEntry({ kind, text }) {
    $('empty').hidden = true;
    const log = $('log');
    let el;
    if (kind === 'user' || kind === 'assistant') {
      el = document.createElement('div');
      el.className = `msg ${kind}`;
      el.textContent = text;
      lastProgress = null;
    } else {
      if (kind === 'progress' && lastProgress && lastProgress.textContent === text) return;
      el = document.createElement('div');
      el.className = `line ${kind}`;
      const ic = document.createElement('span');
      ic.className = 'ic';
      const t = document.createElement('span');
      t.textContent = text;
      el.append(ic, t);
      if (kind === 'progress') lastProgress = t;
    }
    log.append(el);
    while (log.children.length > 200) log.children[1].remove(); // keep the empty-state node
    log.scrollTop = log.scrollHeight;
  }

  function applySettings(s) {
    $('home-name').textContent = s.assistantName;
    $('prompt').placeholder = `Ask ${s.assistantName} to do anything…`;
    const hint = $('home-wake-hint');
    hint.textContent = '';
    if (s.wakeWord) {
      const b = document.createElement('b');
      b.textContent = s.assistantName;
      hint.append('Say “Hey ', b, '” or hold');
    } else {
      hint.append('Hold');
    }
    renderModel();
  }

  async function renderModel() {
    const active = await api.invoke('provider:active');
    $('home-model').textContent = !active.id ? 'No model yet' : active.id === 'local' ? `${active.label} · on this PC` : active.label;
    $('setup').hidden = Boolean(active.id);
  }

  function autosize() {
    const ta = $('prompt');
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    updateSend();
  }

  async function submit(e) {
    if (e) e.preventDefault();
    if (running) { api.invoke('task:stop'); return; }
    const text = $('prompt').value.trim();
    if (!text) return;
    $('prompt').value = '';
    autosize();
    await api.invoke('task:run', text);
  }

  $('composer').addEventListener('submit', submit);
  $('prompt').addEventListener('input', autosize);
  $('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  $('btn-setup').addEventListener('click', () => api.invoke('app:open-settings', 'account'));
  $('btn-select').addEventListener('click', () => api.invoke('select:start'));
  $('region-clear').addEventListener('click', () => api.invoke('region:clear'));
  $('new-chat').addEventListener('click', async () => {
    await api.invoke('conversation:reset');
    [...$('log').querySelectorAll('.msg, .line')].forEach((n) => n.remove());
    $('empty').hidden = false;
  });

  api.on('state', setState);
  api.on('log', addEntry);
  api.on('settings', (s) => { if (s && s.models) applySettings(s); });
  api.on('local:progress', (st) => { if (st.status === 'ready' || st.status === 'none') renderModel(); });
  api.on('usage', ({ session }) => { $('cost').textContent = `$${session.cost.toFixed(session.cost < 1 ? 3 : 2)} this session`; });
  api.on('region', (r) => {
    $('region-chip').hidden = !r;
    if (r) {
      $('region-text').textContent = `Asking about the area you marked (${Math.round(r.width)} × ${Math.round(r.height)})`;
      $('prompt').placeholder = 'What would you like to know about it?';
      setTimeout(() => $('prompt').focus(), 50);
    }
  });
  document.addEventListener('section-shown', (e) => { if (e.detail === 'home') setTimeout(() => $('prompt').focus(), 60); });

  api.invoke('settings:get').then(applySettings);
  api.invoke('app:info').then((info) => setState(info.state));
  api.send('panel:ready');
})();
