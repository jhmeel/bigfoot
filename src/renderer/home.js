'use strict';
// Home: a chat with the assistant. Replies stream in as they're written.

(() => {
  const api = window.buddy;
  const $ = (id) => document.getElementById(id);
  const STATES = {
    idle: ['Ready', 'ok'], listening: ['Listening…', 'busy'], processing: ['Thinking…', 'busy'],
    acting: ['Working…', 'busy'], responding: ['Talking…', 'busy'],
  };
  let running = false;
  let live = null;      // the assistant message being written
  let thinking = null;  // typing indicator while nothing is written yet
  let steps = null;     // the current turn's list of actions

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function scrollDown() {
    const log = $('log');
    log.scrollTop = log.scrollHeight;
  }

  function add(node) {
    $('empty').hidden = true;
    $('log').append(node);
    while ($('log').children.length > 300) $('log').children[1].remove(); // keep the empty state
    scrollDown();
  }

  function assistantBubble() {
    const row = el('div', 'turn assistant');
    const avatar = el('img', 'avatar');
    avatar.src = 'assets/tray@2x.png';
    avatar.alt = '';
    const body = el('div', 'msg assistant');
    row.append(avatar, body);
    return { row, body };
  }

  function showThinking(on) {
    if (on && !thinking && !live) {
      const { row, body } = assistantBubble();
      body.classList.add('typing');
      body.append(el('i'), el('i'), el('i'));
      thinking = row;
      add(row);
    } else if (!on && thinking) {
      thinking.remove();
      thinking = null;
    }
  }

  function setState(s) {
    const [text, cls] = STATES[s] || STATES.idle;
    $('status-text').textContent = text;
    $('status').className = `status ${cls}`;
    running = s === 'processing' || s === 'acting';
    document.body.classList.toggle('running', running);
    showThinking(running);
    updateSend();
  }

  function updateSend() {
    $('send').disabled = !running && !$('prompt').value.trim();
    $('send').title = running ? 'Stop (Esc)' : 'Send (Enter)';
    $('send').setAttribute('aria-label', running ? 'Stop' : 'Send');
  }

  function finishAssistant(text) {
    showThinking(false);
    if (!live) { const { row, body } = assistantBubble(); live = { row, body }; add(row); }
    live.body.textContent = text;
    live = null;
    steps = null;
    scrollDown();
  }

  function addEntry({ kind, text }) {
    if (kind === 'user') {
      steps = null;
      const row = el('div', 'turn user');
      row.append(el('div', 'msg user', text));
      add(row);
      // A spoken request shows "thinking" while it's still being transcribed: keep it under the words.
      if (thinking) { $('log').append(thinking); scrollDown(); }
      return;
    }
    if (kind === 'assistant') { finishAssistant(text); return; }
    // Actions and progress go in a list under the conversation.
    if (!steps) {
      steps = el('div', `steps ${kind === 'error' ? 'error' : ''}`);
      add(steps);
    }
    const last = steps.lastElementChild;
    if (kind === 'progress' && last && last.textContent === text) return;
    const line = el('div', `step ${kind}`, text);
    steps.append(line);
    if (thinking) $('log').append(thinking); // keep the indicator last
    scrollDown();
  }

  function streamText(text) {
    if (!text) { // taken back: the model was asked to act instead of describing
      if (live) { live.row.remove(); live = null; }
      if (running) showThinking(true);
      return;
    }
    showThinking(false);
    if (!live) {
      live = assistantBubble();
      add(live.row);
    }
    live.body.textContent = text;
    scrollDown();
  }

  async function renderSetup() {
    const active = await api.invoke('provider:active');
    $('setup').hidden = Boolean(active.id);
  }

  function autosize() {
    const ta = $('prompt');
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
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
  $('region-clear').addEventListener('click', () => api.invoke('region:clear'));
  $('new-chat').addEventListener('click', async () => {
    await api.invoke('conversation:reset');
    [...$('log').children].forEach((n) => { if (n.id !== 'empty') n.remove(); });
    live = null;
    thinking = null;
    steps = null;
    $('empty').hidden = false;
    $('prompt').focus();
  });

  api.on('state', setState);
  api.on('log', addEntry);
  api.on('log-live', ({ text }) => streamText(text));

  // While the AI loads (at startup, after a model change), questions wait for it: say so.
  function renderLoader(status) {
    if (!status) return;
    const { ai, voice } = status;
    const box = $('ai-loading');
    const loading = ai.state === 'loading' || ai.state === 'preparing';
    box.hidden = !(loading || ai.state === 'failed');
    box.dataset.state = ai.state === 'preparing' ? 'loading' : ai.state;
    $('ai-loading-retry').hidden = ai.state !== 'failed';
    if (ai.state === 'preparing') {
      $('ai-loading-text').textContent = 'Getting ready for first use';
      const secs = Math.round((ai.elapsed || 0) / 1000);
      $('ai-loading-pct').textContent = ai.percent ? `${ai.percent}%` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      $('ai-loading-bar').style.width = `${ai.percent}%`;
      $('ai-loading-note').textContent = 'One time only: Bigfoot is reading its instructions and tools, then saves them so every later start is instant. You can type now; your answer comes right after.';
    } else if (loading) {
      $('ai-loading-text').textContent = `Loading the AI · ${ai.label}`;
      $('ai-loading-pct').textContent = `${ai.percent}%`;
      $('ai-loading-bar').style.width = `${ai.percent}%`;
      const secs = Math.round((ai.elapsed || 0) / 1000);
      $('ai-loading-note').textContent = `You can type now; I’ll answer as soon as it’s loaded.${secs > 30 ? ' This PC is busy, so it’s taking longer: closing a few browser tabs helps.' : ''}${voice.state === 'loading' ? ' Voice is starting too.' : ''}`;
    } else if (ai.state === 'failed') {
      $('ai-loading-text').textContent = 'The AI couldn’t load';
      $('ai-loading-pct').textContent = '';
      $('ai-loading-note').textContent = ai.label;
    }
  }
  api.on('loader', renderLoader);
  api.invoke('loader:status').then(renderLoader).catch(() => {});
  $('ai-loading-retry').addEventListener('click', () => { $('ai-loading-retry').hidden = true; api.invoke('loader:retry'); });
  // The area the user marked, attached to the question it belongs to.
  api.on('log-image', ({ src }) => {
    if (!/^data:image\/(png|jpeg);base64,/.test(String(src))) return;
    const bubbles = $('log').querySelectorAll('.msg.user');
    const last = bubbles[bubbles.length - 1];
    if (!last) return;
    const img = el('img', 'msg-image');
    img.src = src;
    img.alt = 'The area you marked';
    img.addEventListener('load', scrollDown);
    last.prepend(img);
  });
  api.on('settings', (s) => { if (s && s.models) { $('prompt').placeholder = `Message ${s.assistantName}`; renderSetup(); } });
  api.on('local:progress', (st) => { if (st.status === 'ready' || st.status === 'none') renderSetup(); });
  api.on('region', (r) => {
    $('region-chip').hidden = !r;
    if (r) {
      $('region-text').textContent = `Asking about the area you marked (${Math.round(r.width)} × ${Math.round(r.height)})`;
      $('prompt').placeholder = 'What would you like to know about it?';
      setTimeout(() => $('prompt').focus(), 50);
    }
  });
  document.addEventListener('section-shown', (e) => { if (e.detail === 'home') setTimeout(() => $('prompt').focus(), 60); });

  api.invoke('settings:get').then((s) => { $('prompt').placeholder = `Message ${s.assistantName}`; });
  renderSetup();
  api.invoke('app:info').then((info) => setState(info.state));
  api.send('panel:ready');
})();
