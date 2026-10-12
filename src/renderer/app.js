'use strict';
// The main window: sidebar navigation, Home, every settings page, and the Terminal.

(async () => {
  const api = window.buddy;
  const $ = (id) => document.getElementById(id);
  const TITLES = { home: 'Home', terminal: 'Terminal', assistant: 'Assistant', account: 'Models', voice: 'Voice', general: 'General' };
  const ALIASES = { listening: 'voice' }; // older links to the Listening page
  const update = (patch) => api.invoke('settings:update', patch).then((v) => { s = v; return v; });

  let s = await api.invoke('settings:get');
  UI.titlebar();

  // navigation
  let micTesting = false;
  function show(section) {
    section = ALIASES[section] || section;
    if (!TITLES[section]) section = 'home';
    document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.section === section)));
    document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== section; });
    $('section-title').textContent = section === 'assistant' ? s.assistantName : TITLES[section];
    $('pane').scrollTop = 0;
    // Home and Terminal fill the window and scroll inside; settings pages scroll as a whole.
    $('pane').classList.toggle('fill', section === 'home' || section === 'terminal');
    document.dispatchEvent(new CustomEvent('section-shown', { detail: section }));
    if (section !== 'voice' && micTesting) toggleMicTest(false);
    if (section === 'voice') refreshMic();
    // segmented thumbs need layout to measure
    requestAnimationFrame(() => document.querySelectorAll('[data-pane]:not([hidden]) .segmented').forEach((el) => el._seg && el._seg.set(el._value())));
  }
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.section)));
  $('pane').addEventListener('scroll', () => document.querySelector('.content').classList.toggle('scrolled', $('pane').scrollTop > 4));
  document.querySelectorAll('[data-link]').forEach((a) => a.addEventListener('click', () => api.invoke('app:open-link', a.dataset.link)));

  function seg(id, get, onChange) {
    const el = $(id);
    el._seg = UI.segmented(el, get(), onChange);
    el._value = get;
    return el._seg;
  }

  // Assistant
  function renderName() {
    const n = s.assistantName;
    $('hero-name').textContent = n;
    $('nav-name').textContent = n;
    document.querySelectorAll('.name-slot').forEach((el) => { el.textContent = n; });
    if (!document.querySelector('[data-pane="assistant"]').hidden) $('section-title').textContent = n;
    document.title = `${n} Settings`;
  }
  async function refreshWake() {
    const st = $('wake-status');
    if (!s.wakeWord) { st.className = 'status'; st.querySelector('.text').textContent = ''; return; }
    st.className = 'status busy';
    st.querySelector('.text').textContent = 'Starting…';
    const res = await api.invoke('wake:status');
    st.className = `status ${res.active ? 'ok' : 'bad'}`;
    st.querySelector('.text').textContent = res.active ? 'Listening' : 'Unavailable';
    $('wake-hint').textContent = res.active
      ? ''
      : 'Windows speech recognition isn’t available. Add the English speech pack in Windows Settings › Time & language › Speech.';
  }
  $('assistant-name').value = s.assistantName;
  const saveName = async () => {
    const v = $('assistant-name').value.trim();
    if (v === s.assistantName) return;
    await update({ assistantName: v });
    $('assistant-name').value = s.assistantName;
    renderName();
    refreshWake();
  };
  $('assistant-name').addEventListener('change', saveName);
  $('assistant-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('assistant-name').blur(); });
  UI.switchControl($('wake'), s.wakeWord, async (v) => { await update({ wakeWord: v }); refreshWake(); });
  $('rerun-setup').addEventListener('click', () => api.invoke('app:open-onboarding'));
  renderName();
  refreshWake();

  // Models
  const LLM = {
    anthropic: { label: 'Claude', keyName: 'anthropicKey', keyLabel: 'Anthropic API key', modelSetting: 'model', placeholder: 'sk-ant-…' },
    openai: { label: 'OpenAI', keyName: 'openaiKey', keyLabel: 'OpenAI API key', modelSetting: 'openaiModel', placeholder: 'sk-…' },
    custom: { label: 'Custom', keyName: 'customKey', keyLabel: 'API key (optional)', modelSetting: 'customModel', placeholder: 'Leave empty for Ollama / LM Studio' },
  };
  const current = () => LLM[s.provider] || LLM.anthropic;
  let local = null;
  document.addEventListener('section-shown', (e) => {
    if (e.detail === 'account' && !local) local = LocalAI.picker($('local-ai'), { onChange: renderLocalFoot });
  });
  function renderLocalFoot() {
    if (!local) return;
    renderActive();
  }
  UI.switchControl($('keep-loaded'), s.keepAiLoaded, (v) => update({ keepAiLoaded: v }));

  const baseUrlInput = $('custom-base-url');
  if (baseUrlInput) {
    baseUrlInput.value = s.customBaseUrl || '';
    const saveBaseUrl = async () => {
      const val = baseUrlInput.value.trim();
      if (val !== (s.customBaseUrl || '')) {
        await update({ customBaseUrl: val });
        renderModels();
      }
    };
    baseUrlInput.addEventListener('change', saveBaseUrl);
    baseUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBaseUrl(); } });
  }

  const llmKey = UI.keyField({
    input: $('llm-key'), status: $('llm-key-status'), reveal: $('llm-reveal'), remove: $('llm-remove'),
    key: () => current().keyName, has: s.has[current().keyName], placeholder: () => current().placeholder,
    validate: (value) => api.invoke('provider:test', s.provider, value),
    onSaved: async () => { s = await api.invoke('settings:get'); renderModels(); },
  });
  $('llm-key-link').addEventListener('click', () => {
    if (s.provider === 'custom') return;
    api.invoke('app:open-link', s.provider);
  });
  $('llm-test').addEventListener('click', async () => {
    if ($('llm-key').value.trim()) return llmKey.save();
    const st = $('llm-key-status');
    st.className = 'status busy';
    st.querySelector('.text').textContent = 'Checking…';
    const res = await api.invoke('provider:test', s.provider);
    st.className = `status ${res.ok ? 'ok' : 'bad'}`;
    st.querySelector('.text').textContent = res.ok ? 'Connected' : res.message;
  });

  let modelsToken = 0;
  async function renderModels() {
    const cloud = s.provider !== 'local';
    document.querySelectorAll('[data-pane="account"] .cloud-only').forEach((el) => { el.hidden = !cloud; });
    $('custom-url-row').hidden = s.provider !== 'custom';
    $('effort-row').hidden = s.provider !== 'anthropic';
    $('detail-row').hidden = s.provider !== 'anthropic';
    $('provider-hint').textContent = cloud ? 'Online only' : 'Private, works offline';
    if (!cloud) { renderActive(); return; }
    const p = current();
    const token = ++modelsToken;
    $('llm-key-label').textContent = p.keyLabel;
    $('llm-key').placeholder = p.placeholder;
    $('llm-key-link').hidden = s.provider === 'custom';
    if (baseUrlInput) baseUrlInput.value = s.customBaseUrl || '';
    llmKey.setHas(s.has[p.keyName]);

    const sel = $('model');
    const saved = s[p.modelSetting];
    sel.disabled = true;
    sel.innerHTML = '<option>Loading models…</option>';
    let models = [];
    if (s.provider === 'anthropic') models = s.models.map((m) => ({ id: m.id, name: m.label, note: m.note }));
    if (s.has[p.keyName] || s.provider === 'custom') {
      const res = await api.invoke('models:list', s.provider);
      if (token !== modelsToken) return;
      if (res.ok) {
        for (const m of res.models) if (!models.some((x) => x.id === m.id)) models.push(m);
      } else {
        $('model-note').textContent = res.message;
      }
    }
    if (saved && !models.some((m) => m.id === saved)) models.unshift({ id: saved, name: saved });
    sel.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name === m.id ? m.id : `${m.name}`;
      sel.append(o);
    }
    if (saved) sel.value = saved;
    else if (models.length) {
      sel.value = models[0].id;
      await update({ [p.modelSetting]: models[0].id });
    }
    sel.disabled = false;
    const note = models.find((m) => m.id === (sel.value || saved));
    const defaultHint = s.provider === 'custom'
      ? (models.length ? `${models.length} models available` : 'Connect to endpoint to fetch models')
      : `Add your ${p.label} key to load its models.`;
    $('model-note').textContent = note && note.note ? note.note : (s.has[p.keyName] || s.provider === 'custom') ? (sel.value || saved || defaultHint) : defaultHint;
    renderActive();
  }
  $('model').addEventListener('change', async () => {
    await update({ [current().modelSetting]: $('model').value });
    renderModels();
  });
  seg('provider', () => s.provider, async (v) => { await update({ provider: v }); renderModels(); });
  seg('effort', () => s.effort, (v) => update({ effort: v }));
  seg('screen-detail', () => s.screenDetail, (v) => update({ screenDetail: v }));

  async function renderActive() {
    const active = await api.invoke('provider:active');
    const st = $('active-status');
    if (!active.id) {
      $('active-model').textContent = 'No model ready yet';
      $('active-note').textContent = 'Download the model on this PC above.';
      st.className = 'status bad';
      st.querySelector('.text').textContent = 'Not ready';
      return;
    }
    $('active-model').textContent = active.id === 'local' ? `${active.label} · on this PC` : active.label;
    let note = '';
    if (active.id === 'local' && s.provider !== 'local') {
      note = !active.online ? 'You’re offline, so the model on this PC is used.' : `${LLM[s.provider].label} has no key yet, so the model on this PC is used.`;
    } else if (active.id !== 'local' && s.provider === 'local') {
      note = 'The model on this PC isn’t installed yet, so your cloud model is used meanwhile.';
    }
    $('active-note').textContent = note;
    st.className = 'status ok';
    st.querySelector('.text').textContent = active.id === 'local' ? 'Ready · offline capable' : 'Ready · online';
  }
  renderModels();

  // Voice
  const speakHint = () => { $('speak-hint').textContent = ''; };
  UI.switchControl($('speak'), s.speakResponses, async (v) => { await update({ speakResponses: v }); speakHint(); });
  speakHint();
  const previewMsg = 'Built in and private: speech is made on this PC. Press ▶︎ to hear a voice.';
  UI.voicePicker($('voices'), s.voice, {
    onPick: (id) => update({ voice: id }),
    onMessage: (m) => { $('preview-msg').textContent = m || previewMsg; },
  });
  $('rate').value = s.speechRate;
  $('rate').addEventListener('change', () => update({ speechRate: Number($('rate').value) }));

  // Speech recognition (Whisper model picker)
  const whisperContainer = $('whisper-models');
  const whisperStatus = $('whisper-status');
  const whisperMsg = $('whisper-msg');
  let whisperActiveModel = s.whisperModel || 'small.en';
  let downloadingWhisperId = null;

  async function renderWhisperModels() {
    if (!whisperContainer) return;
    const res = await api.invoke('speech:models');
    if (!res || !res.models) return;
    whisperActiveModel = res.active || whisperActiveModel;

    if (whisperStatus) {
      const isReady = res.state === 'ready';
      whisperStatus.className = `status ${isReady ? 'ok' : res.state === 'loading' ? 'busy' : ''}`;
      whisperStatus.querySelector('.text').textContent = isReady ? 'Ready' : res.state === 'loading' ? 'Loading…' : res.state;
    }

    whisperContainer.innerHTML = '';
    for (const m of res.models) {
      const card = document.createElement('div');
      const isSelected = m.id === whisperActiveModel;
      const isDownloading = downloadingWhisperId === m.id || m.downloading;
      card.className = `whisper-card${isSelected ? ' selected' : ''}`;
      card.tabIndex = 0;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(isSelected));
      card.dataset.id = m.id;

      const sizeMB = `${Math.round(m.size / (1024 * 1024))} MB`;

      const info = document.createElement('div');
      info.className = 'model-info';

      const title = document.createElement('div');
      title.className = 'model-title';
      const name = document.createElement('span');
      name.className = 'model-name';
      name.textContent = m.label;
      const badge = document.createElement('span');
      badge.className = 'model-badge';
      badge.textContent = sizeMB;
      title.append(name, badge);

      const note = document.createElement('div');
      note.className = 'model-note';
      note.textContent = m.note || '';
      info.append(title, note);

      const action = document.createElement('div');
      action.className = 'model-action';
      if (isDownloading) {
        const pct = m.progress != null ? `${m.progress}%` : '…';
        action.innerHTML = `<span class="caption" style="color:var(--text-1)">Downloading ${pct}</span>`;
      } else if (isSelected) {
        action.innerHTML = `<span class="badge" style="color:#34d399; background:rgba(52,211,153,0.15)">Active</span>`;
      } else if (m.installed) {
        const btn = document.createElement('button');
        btn.className = 'btn secondary small';
        btn.type = 'button';
        btn.textContent = 'Use';
        action.append(btn);
      } else {
        const btn = document.createElement('button');
        btn.className = 'btn secondary small';
        btn.type = 'button';
        btn.textContent = 'Download';
        action.append(btn);
      }

      card.append(info, action);

      const selectOrDownload = async () => {
        if (downloadingWhisperId) return;
        if (isSelected && m.installed) return;
        if (whisperMsg) whisperMsg.textContent = m.installed ? `Switching to ${m.label}…` : `Downloading ${m.label} (${sizeMB})…`;
        if (!m.installed) {
          downloadingWhisperId = m.id;
          renderWhisperModels();
        }
        try {
          const r = await api.invoke('speech:pick-model', m.id);
          if (r && r.ok) {
            whisperActiveModel = m.id;
            s.whisperModel = m.id;
            if (whisperMsg) whisperMsg.textContent = `Using ${m.label}. Ready for voice commands.`;
          } else {
            if (whisperMsg) whisperMsg.textContent = (r && r.message) || 'Failed to switch model.';
          }
        } catch (err) {
          if (whisperMsg) whisperMsg.textContent = err.message || 'Error updating speech model.';
        } finally {
          downloadingWhisperId = null;
          renderWhisperModels();
        }
      };

      card.addEventListener('click', () => selectOrDownload());
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectOrDownload(); }
      });

      whisperContainer.append(card);
    }
  }

  api.on('speech:progress', (data) => {
    if (!data) return;
    downloadingWhisperId = data.id;
    if (whisperMsg) whisperMsg.textContent = `Downloading speech model (${data.percent}%)…`;
    const card = whisperContainer && whisperContainer.querySelector(`.whisper-card[data-id="${data.id}"]`);
    if (card) {
      const act = card.querySelector('.model-action');
      if (act) act.innerHTML = `<span class="caption" style="color:var(--text-1)">${data.percent}%</span>`;
    }
  });

  api.on('speech:state', (st) => {
    if (whisperStatus && st) {
      const isReady = st.state === 'ready';
      whisperStatus.className = `status ${isReady ? 'ok' : st.state === 'loading' ? 'busy' : ''}`;
      whisperStatus.querySelector('.text').textContent = isReady ? 'Ready' : st.state === 'loading' ? 'Loading…' : st.state;
    }
  });

  renderWhisperModels();

  // Microphone

  const drawMeter = UI.meter($('mic-meter'));
  api.on('level', (l) => { if (micTesting) drawMeter(l); });
  async function refreshMic() {
    const status = await api.invoke('mic:status');
    const st = $('mic-status');
    const ok = status === 'granted' || status === 'not-determined' || status === 'unknown';
    st.className = `status ${ok ? 'ok' : 'bad'}`;
    st.querySelector('.text').textContent = ok ? 'Allowed' : 'Blocked by Windows';
    $('mic-hint').textContent = ok ? '' : 'Turn on “Let desktop apps access your microphone” in Windows Settings.';
  }
  async function toggleMicTest(on) {
    micTesting = on;
    $('mic-test').textContent = on ? 'Stop Test' : 'Test Microphone';
    if (!on) { drawMeter(0); await api.invoke('mic:test', false); return; }
    const res = await api.invoke('mic:test', true);
    if (!res.ok) {
      micTesting = false;
      $('mic-test').textContent = 'Test Microphone';
      const st = $('mic-status');
      st.className = 'status bad';
      st.querySelector('.text').textContent = /denied/i.test(res.message) ? 'Blocked by Windows' : res.message;
    }
  }
  $('mic-test').addEventListener('click', () => toggleMicTest(!micTesting));
  $('mic-settings').addEventListener('click', () => api.invoke('app:open-link', 'micSettings'));
  window.addEventListener('focus', () => { if (!$('mic-status').closest('[hidden]')) refreshMic(); });

  // General
  UI.switchControl($('show-buddy'), s.showBuddy, (v) => update({ showBuddy: v }));
  UI.switchControl($('sounds'), s.soundEffects, (v) => update({ soundEffects: v }));
  UI.switchControl($('login'), s.launchAtLogin, (v) => update({ launchAtLogin: v }));
  UI.switchControl($('tool-tray'), s.toolTray, (v) => update({ toolTray: v }));
  LocalAI.banner($('lai-banner'));
  $('open-logs').addEventListener('click', () => api.invoke('app:open-logs'));
  $('open-plugins').addEventListener('click', () => api.invoke('app:open-plugins'));
  api.invoke('app:info').then((info) => { $('version').textContent = `Version ${info.version}`; });

  // Plugins
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function pluginRow(title, detail, badge, { error = false, action = null, plain = false } = {}) {
    const row = el('div', 'row');
    const label = el('div', 'label');
    label.append(el('span', 'headline', title), el('div', `hint${error ? ' error' : plain ? '' : ' mono-list'}`, detail));
    row.append(label);
    if (action) row.append(action);
    if (badge) row.append(el('span', 'badge custom', badge));
    return row;
  }

  async function renderPlugins() {
    const { builtin, custom } = await api.invoke('plugins:list');
    const list = $('plugin-list');
    list.textContent = '';
    for (const g of builtin) list.append(pluginRow(g.title, g.tools.join(' · '), null));
    if (!custom.length) {
      list.append(pluginRow('No custom plugins yet', 'Add Plugin… opens beside a template you can copy and edit.', null, { plain: true }));
    }
    for (const p of custom) {
      const remove = el('button', 'btn plain small', 'Remove');
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Remove ${p.file}? It moves to the Recycle Bin and its tools stop working.`)) return;
        await api.invoke('plugins:remove', p.file);
        renderPlugins();
      });
      list.append(pluginRow(p.file, p.error || p.tools.join(' · '), p.error ? 'Not loaded' : 'Custom', { error: Boolean(p.error), action: remove }));
    }
  }

  function renderReview(report) {
    const box = $('plugin-review');
    box.textContent = '';
    box.hidden = false;
    box.className = `plugin-review ${report.ok ? 'ok' : 'bad'}`;
    const head = el('div', 'pr-head');
    head.append(el('span', 'headline', report.ok ? `Ready to install ${report.name}` : `${report.name} can’t be installed`));
    box.append(head);
    const section = (title, items, cls) => {
      if (!items.length) return;
      box.append(el('div', 'pr-label', title));
      const ul = el('ul', `pr-list ${cls || ''}`);
      for (const t of items) ul.append(el('li', null, t));
      box.append(ul);
    };
    section('Problems to fix', report.errors, 'bad');
    section('Adds these tools', report.tools.map((t) => `${t.name}: ${t.description}`));
    section('This plugin’s code can', report.capabilities.length ? report.capabilities : ['Nothing beyond its own logic'], 'caps');
    section('Suggestions', report.warnings, 'warn');
    const foot = el('div', 'pr-foot');
    foot.append(el('span', 'caption', report.ok
      ? 'Plugins run with the same access as Bigfoot. Only install plugins you wrote or trust.'
      : 'Fix the problems above, then choose the file again.'));
    foot.append(el('span', 'spacer'));
    const cancel = el('button', 'btn plain small', report.ok ? 'Cancel' : 'Close');
    cancel.addEventListener('click', () => { box.hidden = true; });
    foot.append(cancel);
    if (report.ok) {
      const install = el('button', 'btn primary small', 'Install');
      install.addEventListener('click', async () => {
        install.disabled = true;
        const res = await api.invoke('plugins:install', report.file);
        if (res.ok) {
          box.className = 'plugin-review ok';
          box.textContent = '';
          box.append(el('span', 'headline', `Installed ${report.name}. Its tools are available from your next request.`));
          setTimeout(() => { box.hidden = true; }, 5000);
          renderPlugins();
        } else {
          renderReview({ ...report, ...res.report, ok: false });
        }
      });
      foot.append(install);
    }
    box.append(foot);
  }

  $('plugin-add').addEventListener('click', async () => {
    $('plugin-add').disabled = true;
    try {
      const report = await api.invoke('plugins:pick');
      if (report) renderReview(report);
    } finally {
      $('plugin-add').disabled = false;
    }
  });
  renderPlugins();

  api.on('settings', (v) => {
    if (v && v.section) { show(v.section); return; }
    if (v && v.models) s = v;
  });

  show(new URLSearchParams(location.search).get('section') || 'home');
})();
